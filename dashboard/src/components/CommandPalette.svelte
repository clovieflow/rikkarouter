<script lang="ts">
  // Command palette (§36): minimal black panel, pink active highlight, keyboard-first.
  import { onDestroy } from "svelte";
  import Icon from "./Icon.svelte";
  import { NAV, go } from "../lib/nav.ts";
  import { api, listCombos } from "../lib/api.ts";

  let { onclose }: { onclose: () => void } = $props();

  interface Cmd {
    group: string;
    label: string;
    hint?: string;
    icon: string;
    run: () => void;
  }

  const navCmds: Cmd[] = NAV.flatMap((s) =>
    s.items.map((i) => ({ group: "Navigate", label: i.label, hint: i.shortcut, icon: i.id, run: () => go(i.href.replace(/^#/, "")) })),
  );

  // Verb actions (§36) — every action navigates somewhere real or reads live
  // data; nothing is faked. The API has no remote-disable endpoint, so
  // "Disable provider…" navigates to /providers where removal happens.
  const actions: Cmd[] = [
    { group: "Actions", label: "Create route", hint: "/routes", icon: "routes", run: () => go("/routes") },
    { group: "Actions", label: "Open failed requests", hint: "/requests", icon: "requests", run: () => go("/requests") },
    { group: "Actions", label: "Show expensive models", hint: "/costs", icon: "costs", run: () => go("/costs") },
    { group: "Actions", label: "Compare provider latency", hint: "/analytics", icon: "analytics", run: () => go("/analytics") },
    { group: "Actions", label: "Open providers…", hint: "/providers", icon: "providers", run: () => go("/providers") },
    { group: "Actions", label: "Create API key", hint: "/keys", icon: "keys", run: () => go("/keys") },
    { group: "Actions", label: "Open API keys", hint: "/keys", icon: "keys", run: () => go("/keys") },
    { group: "Actions", label: "View system health", hint: "/status", icon: "status", run: () => go("/status") },
  ];

  let dynamic: Cmd[] = $state([]);
  async function loadDynamic(): Promise<void> {
    try {
      const [combos, reg, lg, keys, conns] = await Promise.all([
        listCombos().catch(() => ({ combos: [] as { id: string; name: string; enabled: number }[] })),
        api.registry().catch(() => ({ providers: [] as { id: string; name: string; models: { id: string; name: string }[] }[] })),
        api.logs(200).catch(() => ({ rows: [] as { seq: number; method: string; path: string; status: number }[] })),
        api.keys().catch(() => ({ keys: [] as { id: string; name: string }[] })),
        api.connections().catch(() => ({ providers: [] as { id: string; provider: string; name: string; status: string }[] })),
      ]);
      const out: Cmd[] = [];
      for (const c of (combos.combos ?? []).slice(0, 20))
        out.push({ group: "Routes", label: c.name, hint: `${c.enabled ? "" : "paused · "}/routes/${c.id}`, icon: "routes", run: () => go(`/routes/${c.id}`) });
      for (const p of reg.providers ?? [])
        for (const m of p.models.slice(0, 6))
          out.push({ group: "Models", label: m.name, hint: `${p.name} · /models`, icon: "models", run: () => go("/models") });
      for (const l of (lg.rows ?? []).filter((r) => r.status >= 400 && r.path.startsWith("/v1")).slice(0, 8))
        out.push({ group: "Requests", label: `${l.method} ${l.path} · ${l.status}`, hint: "/requests", icon: "requests", run: () => go("/requests") });
      for (const l of (lg.rows ?? []).filter((r) => r.status >= 500 || r.status === 499).slice(0, 8))
        out.push({ group: "Logs", label: `${l.path} → ${l.status}`, hint: "error · /logs", icon: "logs", run: () => go("/logs") });
      for (const k of (keys.keys ?? []).slice(0, 10))
        out.push({ group: "Keys", label: k.name, hint: "/keys", icon: "keys", run: () => go("/keys") });
      for (const c of (conns.providers ?? []).slice(0, 10))
        out.push({ group: "Providers", label: `Open ${c.provider}${c.name ? ` · ${c.name}` : ""}`, hint: `${c.status} · /providers/${c.id}`, icon: "providers", run: () => go(`/providers/${c.id}`) });
      dynamic = out;
    } catch {
      // palette stays usable with static commands
    }
  }
  void loadDynamic();

  let q = $state("");
  let sel = $state(0);
  let input: HTMLInputElement;

  const all = $derived([...actions, ...navCmds, ...dynamic]);
  const results = $derived(
    q.trim()
      ? all.filter((c) => (c.label + " " + c.group + " " + (c.hint ?? "")).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 15)
      : all.slice(0, 15),
  );
  // Grouped rendering (§37) — flat keyboard index, one header per group.
  const grouped = $derived.by(() => {
    const order: string[] = [];
    const map = new Map<string, { cmd: Cmd; idx: number }[]>();
    results.forEach((cmd, idx) => {
      if (!map.has(cmd.group)) {
        map.set(cmd.group, []);
        order.push(cmd.group);
      }
      map.get(cmd.group)!.push({ cmd, idx });
    });
    return order.map((group) => ({ group, items: map.get(group)! }));
  });
  $effect(() => {
    if (sel >= results.length) sel = Math.max(0, results.length - 1);
  });
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(sel + 1, results.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(sel - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[sel]?.run();
      onclose();
    } else if (e.key === "Escape") {
      onclose();
    }
  }
  onDestroy(() => {});
  $effect(() => {
    input?.focus();
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="scrim" onclick={onclose} role="presentation">
  <div class="palette" role="dialog" aria-label="Command palette" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey}>
    <div class="inp">
      <Icon name="command" size={14} class="ci" />
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <input
        bind:this={input}
        type="text"
        placeholder="Try “create route”, “failed requests”, “disable provider”…"
        aria-label="Command query"
        bind:value={q}
        oninput={() => (sel = 0)}
      />
      <kbd>esc</kbd>
    </div>
    <ul>
      {#each grouped as g (g.group)}
        <li class="gh" aria-hidden="true">{g.group}</li>
        {#each g.items as { cmd: c, idx: i } (c.label + c.group + (c.hint ?? ""))}
          <li>
            <button class="item" class:act={i === sel} onclick={() => { c.run(); onclose(); }} onmouseenter={() => (sel = i)}>
              <Icon name={c.icon} size={14} />
              <span class="l">{c.label}</span>
              {#if c.hint}<kbd>{c.hint}</kbd>{/if}
            </button>
          </li>
        {/each}
      {:else}
        <li class="none">No match for “{q}” — try “route”, “model”, “failed”, “key”.</li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(3, 3, 5, 0.72);
    display: flex;
    justify-content: center;
    padding-top: 14vh;
    z-index: 100;
    animation: fade 140ms var(--ease-out) both;
  }
  @keyframes fade {
    from { opacity: 0; }
  }
  .palette {
    width: min(560px, 92vw);
    max-height: 60vh;
    background: #0a0a0f;
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-panel);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: rise var(--dur-micro) var(--ease-out) both;
  }
  .inp {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--color-edge);
  }
  :global(.ci) {
    color: var(--color-pink);
  }
  input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--color-ink);
    font-family: inherit;
    font-size: 14px;
  }
  input::placeholder {
    color: var(--color-ink-faint);
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--color-ink-faint);
    border: 1px solid var(--color-edge);
    background: var(--color-elevated);
    border-radius: 4px;
    padding: 1px 5px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
  }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 9px;
    background: none;
    border: none;
    border-radius: var(--radius-ctl);
    color: var(--color-ink-soft);
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .item.act {
    background: rgba(255, 22, 140, 0.1);
    color: var(--color-ink);
  }
  .item.act :global(svg) {
    color: var(--color-pink);
  }
  .l {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gh {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-ink-faint);
    padding: 8px 9px 2px;
  }
  .none {
    padding: 14px;
    color: var(--color-ink-faint);
    font-size: 12.5px;
    text-align: center;
  }
</style>

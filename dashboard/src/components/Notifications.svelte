<script lang="ts">
  // Topbar notifications: bell + dropdown panel (§09). All items derived
  // client-side from existing endpoints — no new API. Sources:
  //   - providers in cooldown (GET /api/providers, cooldown_until > now)
  //   - key budgets at ≥80% spend (GET /api/keys + GET /api/keys/:id/budget)
  // Empty = honest "all clear" state per §38, never invented counts.
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import { api, type Connection } from "../lib/api.ts";
  import { go } from "../lib/nav.ts";

  interface Note {
    id: string;
    kind: "cooldown" | "budget";
    title: string;
    desc: string;
    href: string;
  }

  let open = $state(false);
  let notes = $state<Note[]>([]);
  let loaded = $state(false);
  let panelEl: HTMLElement | null = $state(null);
  let btnEl: HTMLElement | null = $state(null);

  function fmtRemain(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  async function load(): Promise<void> {
    try {
      const { providers } = await api.connections();
      const now = Date.now();
      const out: Note[] = [];
      const conns: Connection[] = providers ?? [];
      for (const c of conns) {
        if (c.status === "cooldown" && c.cooldown_until > now) {
          out.push({
            id: `cd-${c.id}`,
            kind: "cooldown",
            title: `${c.name || c.provider} in cooldown`,
            desc: c.last_error
              ? `${c.last_error.slice(0, 120)} · back in ${fmtRemain(c.cooldown_until - now)}`
              : `Back in ${fmtRemain(c.cooldown_until - now)}`,
            href: "#/providers",
          });
        }
      }
      try {
        const { keys } = await api.keys();
        for (const k of keys ?? []) {
          try {
            const b = await api.getBudget(k.id);
            if (b.budget != null && b.budget > 0 && b.spent / b.budget >= 0.8) {
              const p = Math.round((b.spent / b.budget) * 100);
              out.push({
                id: `bg-${k.id}`,
                kind: "budget",
                title: `Key “${k.name}” at ${p}% of budget`,
                desc: `${b.spent} of ${b.budget} spent — raise the cap or rotate spend before it caps.`,
                href: "#/keys",
              });
            }
          } catch {
            // Single-key budget failure must not kill the whole panel.
          }
        }
      } catch {
        // Keys endpoint unavailable — cooldown notes still stand.
      }
      notes = out;
    } catch {
      notes = [];
    } finally {
      loaded = true;
    }
  }

  function onDocClick(e: MouseEvent): void {
    if (!open) return;
    const t = e.target as Node | null;
    if (panelEl?.contains(t) || btnEl?.contains(t)) return;
    open = false;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") open = false;
  }

  function jump(href: string): void {
    open = false;
    go(href);
  }

  onMount(() => {
    load();
    const t = setInterval(load, 30_000);
    document.addEventListener("click", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(t);
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="bellwrap">
  <button
    bind:this={btnEl}
    class="bell"
    class:has={notes.length > 0}
    onclick={() => (open = !open)}
    aria-label={notes.length ? `${notes.length} notifications` : "Notifications — all clear"}
    aria-expanded={open}
    aria-haspopup="true"
  >
    <Icon name="bell" size={15} />
    {#if notes.length > 0}
      <span class="badge" aria-hidden="true">{notes.length > 9 ? "9+" : notes.length}</span>
    {/if}
  </button>

  {#if open}
    <div bind:this={panelEl} class="panel" role="menu" aria-label="Notifications">
      <div class="phead">
        <span>Notifications</span>
        <span class="pcount">{loaded ? `${notes.length} active` : "loading…"}</span>
      </div>
      {#if !loaded}
        <p class="pload">Checking providers and budgets…</p>
      {:else if notes.length === 0}
        <div class="pempty" role="status">
          <Icon name="check" size={16} />
          <strong>All clear</strong>
          <p>No provider cooldowns and no key budgets past 80%. This panel only reports live server state — nothing is fabricated.</p>
        </div>
      {:else}
        <ul>
          {#each notes as n (n.id)}
            <li>
              <button class="note" onclick={() => jump(n.href)} role="menuitem">
                <span class="dot" class:warn={n.kind === "cooldown"} class:bad={n.kind === "budget"} aria-hidden="true"></span>
                <span class="nt">
                  <strong>{n.title}</strong>
                  <small>{n.desc}</small>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .bellwrap {
    position: relative;
  }
  .bell {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-ctl);
    background: none;
    border: 1px solid transparent;
    color: var(--color-ink-muted);
    cursor: pointer;
    transition: color var(--dur-micro) var(--ease-out), background var(--dur-micro) var(--ease-out), border-color var(--dur-micro) var(--ease-out);
  }
  .bell:hover {
    color: var(--color-ink);
    background: rgba(255, 255, 255, 0.04);
    border-color: var(--color-edge);
  }
  .badge {
    position: absolute;
    top: 1px;
    right: 0;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--color-pink);
    box-shadow: var(--glow-pink);
    color: #fff;
    font-size: 9.5px;
    font-weight: 700;
    line-height: 15px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .panel {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    width: 320px;
    max-width: calc(100vw - 32px);
    background: var(--color-raised);
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-panel);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
    z-index: 60;
    overflow: hidden;
    animation: rise var(--dur-panel) var(--ease-out);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
  }
  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--color-edge);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--color-ink);
  }
  .pcount {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .pload {
    margin: 0;
    padding: 18px 14px;
    font-size: 12px;
    color: var(--color-ink-faint);
    text-align: center;
  }
  .pempty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 22px 18px;
    text-align: center;
    color: var(--color-ok);
  }
  .pempty strong {
    font-size: 13px;
    color: var(--color-ink);
  }
  .pempty p {
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: var(--color-ink-muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    max-height: 340px;
    overflow-y: auto;
  }
  .note {
    display: flex;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--radius-input);
    padding: 9px 10px;
    cursor: pointer;
    font-family: inherit;
    transition: background var(--dur-micro) var(--ease-out);
  }
  .note:hover {
    background: rgba(255, 255, 255, 0.04);
  }
  .dot {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-top: 5px;
  }
  .dot.warn { background: var(--color-warn); }
  .dot.bad { background: var(--color-bad); }
  .nt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .nt strong {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--color-ink);
  }
  .nt small {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--color-ink-muted);
  }
</style>

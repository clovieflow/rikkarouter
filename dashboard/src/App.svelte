<script lang="ts">
  import "@fontsource-variable/inter";
  import "./styles/tokens.css";
  import Icon from "./components/Icon.svelte";
  import Overview from "./pages/Overview.svelte";
  import CommandPalette from "./components/CommandPalette.svelte";
  import ToastHost from "./components/ToastHost.svelte";
  import Notifications from "./components/Notifications.svelte";
  import { NAV, route, go } from "./lib/nav.ts";
  import { api } from "./lib/api.ts";
  // Route splitting: Overview (first paint) + shell stay in the entry chunk;
  // every other page lazy-loads on first visit. Keys must stay static so
  // Vite can pre-split them into separate chunks at build time.
  type PageMod = { default: unknown };
  const loaders: Record<string, () => Promise<PageMod>> = {
    "/providers": () => import("./pages/Providers.svelte"),
    "/models": () => import("./pages/Models.svelte"),
    "/requests": () => import("./pages/Requests.svelte"),
    "/logs": () => import("./pages/Logs.svelte"),
    "/analytics": () => import("./pages/Analytics.svelte"),
    "/keys": () => import("./pages/Keys.svelte"),
    "/aliases": () => import("./pages/Aliases.svelte"),
    "/status": () => import("./pages/Status.svelte"),
    "/routes": () => import("./pages/Routes.svelte"),
    "/playground": () => import("./pages/Playground.svelte"),
    "/costs": () => import("./pages/Costs.svelte"),
    "/policies": () => import("./pages/Policies.svelte"),
    "/settings": () => import("./pages/Settings.svelte"),
    "/changelog": () => import("./pages/Changelog.svelte"),
    "/chats": () => import("./pages/Chats.svelte"),
    "/proxies": () => import("./pages/Proxies.svelte"),
    "/docs": () => import("./pages/Docs.svelte"),
  };
  const detailLoaders: Array<{ prefix: string; load: () => Promise<PageMod> }> = [
    { prefix: "/routes/", load: () => import("./pages/RouteDetail.svelte") },
    { prefix: "/providers/", load: () => import("./pages/ProviderDetail.svelte") },
  ];

  let paletteOpen = $state(false);
  let collapsed = $state(localStorage.getItem("rikka.side") === "1");
  let userOpen = $state(false);
  let mobileOpen = $state(false);
  let umenu: HTMLDivElement | undefined = $state();

  // A5: focus enters the account menu on open; arrows move between items.
  $effect(() => {
    if (userOpen) queueMicrotask(() => firstMenuItem()?.focus());
  });
  function menuItems(): HTMLElement[] {
    if (!umenu) return [];
    const nodes = umenu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])');
    const out: HTMLElement[] = [];
    nodes.forEach((n) => {
      if (n instanceof HTMLElement) out.push(n);
    });
    return out;
  }
  function firstMenuItem(): HTMLElement | undefined {
    return menuItems()[0];
  }
  function menuKey(e: KeyboardEvent): void {
    const items = menuItems();
    if (!items.length) return;
    const active = document.activeElement;
    const cur = active instanceof HTMLElement ? items.indexOf(active) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(cur + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(cur - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === "Escape") {
      userOpen = false;
    }
  }
  let healthOk = $state<boolean | null>(null);
  let healthVer = $state("");

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      paletteOpen = !paletteOpen;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "1") {
      e.preventDefault();
      go("/");
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
      e.preventDefault();
      go("/routes");
    }
    if (e.key === "Escape") {
      paletteOpen = false;
      userOpen = false;
      mobileOpen = false;
    }
  }
  function tickClock() {
    clock.set(new Date());
  }
  async function pollHealth() {
    try {
      const h = await api.health();
      healthOk = h.ok;
      healthVer = h.version ?? "";
    } catch {
      healthOk = false;
      healthVer = "";
    }
  }
  import { writable } from "svelte/store";
  import { onMount } from "svelte";
  const clock = writable(new Date());

  onMount(() => {
    window.addEventListener("keydown", onKey);
    const t = setInterval(tickClock, 1000);
    pollHealth();
    const h = setInterval(pollHealth, 30_000);
    const onDoc = (e: MouseEvent) => {
      if (!userOpen) return;
      if ((e.target as HTMLElement | null)?.closest?.(".avatarwrap")) return;
      userOpen = false;
    };
    document.addEventListener("click", onDoc);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearInterval(t);
      clearInterval(h);
      document.removeEventListener("click", onDoc);
    };
  });

  let current = $derived($route);
  // Dynamic detail routes: #/routes/:id and #/providers/:id; exact map first.
  // Overview is bundled; everything else resolves through a lazy loader so
  // each page becomes its own chunk. Unknown routes fall back to Overview.
  function loaderFor(path: string): () => Promise<PageMod> {
    return loaders[path] ?? detailLoaders.find((d) => path.startsWith(d.prefix))?.load ?? (async () => ({ default: Overview }));
  }
  let crumb = $derived(
    NAV.flatMap((s) => s.items).find((i) => i.href === `#${current}`)?.label ??
      (current.startsWith("/routes/") ? "Route detail" : current.startsWith("/providers/") ? "Provider detail" : current === "/playground" ? "Playground" : "Overview"),
  );
</script>

<svelte:window on:hashchange={() => route.set(location.hash.slice(1) || "/")} />

<div class="shell" class:collapsed class:mopen={mobileOpen}>
  <aside class="side">
    <a class="brand" href="#/" aria-label="Rikka home">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 12h6M15 5h6M15 12h6M15 19h6" stroke="#3c8cff" stroke-width="1.6" fill="none" stroke-linecap="round" />
        <path d="M9 12l6-7M9 12l6 0M9 12l6 7" stroke="#ff168c" stroke-width="1.6" fill="none" stroke-linecap="round" />
        <circle cx="9" cy="12" r="2.1" fill="#050507" stroke="#f5f5f7" stroke-width="1.4" />
      </svg>
      <span class="bn">Rikka<b class="bdot">.</b></span>
    </a>

    <nav aria-label="Primary">
      {#each NAV as group}
        <div class="grp">
          <span class="grp-l">{group.section}</span>
          {#each group.items as item (item.href)}
            <a
              href={item.href}
              class="nav-i"
              class:on={item.href === `#${current}`}
              aria-current={item.href === `#${current}` ? "page" : undefined}
            >
              <Icon name={item.id} size={15} class="ni" />
              <span class="nl">{item.label}</span>
              {#if item.shortcut}<kbd>{item.shortcut}</kbd>{/if}
            </a>
          {/each}
        </div>
      {/each}
    </nav>

    <div class="hints" aria-label="Keyboard shortcuts">
      <span><kbd>⌘K</kbd> search</span>
      <span><kbd>⌘1</kbd> overview</span>
      <span><kbd>⌘R</kbd> routes</span>
    </div>
    <button class="collapse" onclick={() => { collapsed = !collapsed; localStorage.setItem("rikka.side", collapsed ? "1" : "0"); }} aria-label="Toggle sidebar">
      <Icon name={collapsed ? "check" : "x"} size={13} />
      <span>{collapsed ? "Expand" : "Collapse"}</span>
    </button>
  </aside>

  {#if mobileOpen}
    <button class="scrim" onclick={() => (mobileOpen = false)} aria-label="Close navigation"></button>
  {/if}

  <div class="main">
    <header class="top">
      <button class="ham" onclick={() => (mobileOpen = !mobileOpen)} aria-label="Toggle navigation" aria-expanded={mobileOpen}>
        <Icon name={mobileOpen ? "x" : "command"} size={16} />
      </button>
      <div class="crumb" aria-label="Breadcrumb">
        <span class="sys">rikka</span><span class="sep">/</span><span>{crumb}</span>
      </div>
      <button class="cmd" onclick={() => (paletteOpen = true)} aria-label="Open command palette">
        <Icon name="search" size={13} />
        <span class="cmd-t">Search anything…</span>
        <kbd>⌘K</kbd>
      </button>
      <div class="right">
        <Notifications />
        <span
          class="sdot"
          class:ok={healthOk === true}
          class:bad={healthOk === false}
          title={healthOk === null ? "Checking server health…" : healthOk ? `Server healthy${healthVer ? ` · v${healthVer}` : ""}` : "Server unreachable — see Status"}
          role="status"
          aria-label={healthOk === null ? "Server status: checking" : healthOk ? "Server status: healthy" : "Server status: unreachable"}
        ></span>
        <span class="env" title="Single local instance — environment switcher arrives with multi-workspace auth">
          <Icon name="status" size={13} />
          local
        </span>
        <div class="avatarwrap">
          <button class="avatar" onclick={() => (userOpen = !userOpen)} aria-label="Account menu" aria-expanded={userOpen} aria-haspopup="menu">
            R
          </button>
          {#if userOpen}
            <div class="umenu" role="menu" aria-label="Account" tabindex="-1" bind:this={umenu} onkeydown={menuKey}>
              <a href="#/settings" role="menuitem" onclick={() => (userOpen = false)}>Settings</a>
              <a href="#/status" role="menuitem" onclick={() => (userOpen = false)}>Status</a>
              <span class="uno" role="menuitem" aria-disabled="true" title="No auth API — single local operator, nothing to sign out of">Log out · unavailable</span>
            </div>
          {/if}
        </div>
        <span class="clock" aria-label="Local clock">{new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format($clock)}</span>
      </div>
    </header>

    <main class="content">
      {#key current}
        {#await loaderFor(current)() then mod}
          {@const Page = mod.default as any}
          <Page />
        {:catch}
          <p class="page-err" role="alert">Failed to load this page. <a href="#/">Back to Overview</a></p>
        {/await}
      {/key}
    </main>
  </div>
</div>

{#if paletteOpen}
  <CommandPalette onclose={() => (paletteOpen = false)} />
{/if}
<ToastHost />

<style>
  .page-err {
    padding: 24px;
    color: var(--color-bad);
    font-size: 13px;
  }
  .shell {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    min-height: 100vh;
    width: 100%;
    max-width: 100vw;
    overflow-x: hidden;
  }
  .shell.collapsed {
    grid-template-columns: 64px minmax(0, 1fr);
  }
  .side {
    background: var(--color-base);
    border-right: 1px solid var(--color-edge);
    display: flex;
    flex-direction: column;
    padding: 14px 10px 12px;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    overflow-x: hidden;
    z-index: 30;
    user-select: none;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 4px 8px 16px;
    text-decoration: none;
  }
  .bn {
    font-size: 15px;
    font-weight: 700;
    color: var(--color-ink);
    letter-spacing: 0.01em;
  }
  .bdot {
    color: var(--color-pink);
  }
  nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .grp {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .grp-l {
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--color-ink-faint);
    padding: 0 10px 4px;
  }
  .nav-i {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 10px;
    border-radius: var(--radius-ctl);
    color: var(--color-ink-muted);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    transition: background var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
    position: relative;
    white-space: nowrap;
  }
  .nav-i:hover {
    color: var(--color-ink);
    background: rgba(255, 255, 255, 0.04);
  }
  .nav-i.on {
    color: var(--color-ink);
    background: rgba(255, 22, 140, 0.09);
  }
  .nav-i.on::before {
    content: "";
    position: absolute;
    left: -10px;
    top: 7px;
    bottom: 7px;
    width: 2.5px;
    border-radius: 2px;
    background: var(--color-pink);
    box-shadow: var(--glow-pink);
  }
  kbd {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--color-ink-faint);
    border: 1px solid var(--color-edge);
    background: var(--color-elevated);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .collapse {
    display: flex;
    gap: 8px;
    align-items: center;
    background: none;
    border: none;
    color: var(--color-ink-faint);
    font-family: inherit;
    font-size: 11.5px;
    padding: 8px 10px 4px;
    cursor: pointer;
    border-radius: var(--radius-ctl);
    transition: color var(--dur-micro) var(--ease-out), background var(--dur-micro) var(--ease-out);
  }
  .collapse:hover {
    color: var(--color-ink);
    background: rgba(255, 255, 255, 0.04);
  }
  .collapsed .nl,
  .collapsed .grp-l,
  .collapsed .bn,
  .collapsed kbd,
  .collapsed .hints,
  .collapsed .collapse span {
    display: none;
  }
  .collapsed .side {
    padding: 14px 6px 12px;
  }
  .collapsed .nav-i {
    justify-content: center;
    padding: 8px 0;
  }
  .collapsed .collapse {
    justify-content: center;
    padding: 8px 0;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    width: 100%;
    overflow-x: hidden;
  }
  .top {
    height: 64px;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 24px;
    border-bottom: 1px solid var(--color-edge);
    background: color-mix(in srgb, var(--color-void) 85%, transparent);
    backdrop-filter: blur(12px);
    position: sticky;
    top: 0;
    z-index: 20;
  }
  .crumb {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--color-ink-muted);
    white-space: nowrap;
  }
  .sys {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-ink-faint);
    border: 1px solid var(--color-edge);
    border-radius: 4px;
    padding: 1px 6px;
  }
  .sep {
    color: var(--color-ink-faint);
  }
  .cmd {
    flex: 1;
    max-width: 420px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px;
    background: var(--color-elevated);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-input);
    color: var(--color-ink-faint);
    font-family: inherit;
    font-size: 12.5px;
    cursor: pointer;
    transition: border-color var(--dur-micro) var(--ease-out);
  }
  .cmd:hover {
    border-color: var(--color-edge-strong);
    color: var(--color-ink-soft);
  }
  .cmd-t {
    flex: 1;
    text-align: left;
  }
  .ham {
    display: none;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-ctl);
    color: var(--color-ink-muted);
    cursor: pointer;
    transition: color var(--dur-micro) var(--ease-out), background var(--dur-micro) var(--ease-out);
  }
  .ham:hover {
    color: var(--color-ink);
    background: rgba(255, 255, 255, 0.04);
  }
  .scrim {
    display: none;
  }
  .hints {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 10px 6px;
    font-size: 10.5px;
    color: var(--color-ink-faint);
  }
  .hints span {
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .hints kbd {
    margin-left: 0;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }
  .sdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-ink-faint);
    flex-shrink: 0;
  }
  .sdot.ok {
    background: var(--color-ok);
    animation: pulse-dot 2.4s ease-in-out infinite;
  }
  .sdot.bad {
    background: var(--color-bad);
  }
  .avatarwrap {
    position: relative;
  }
  .avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid var(--color-edge-strong);
    background: var(--color-elevated);
    color: var(--color-ink-soft);
    font-family: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: border-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
  }
  .avatar:hover {
    border-color: var(--color-pink);
    color: var(--color-ink);
  }
  .umenu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 190px;
    background: var(--color-raised);
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-panel);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
    padding: 6px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    animation: rise var(--dur-panel) var(--ease-out);
  }
  .umenu a {
    padding: 8px 10px;
    border-radius: var(--radius-input);
    font-size: 12.5px;
    color: var(--color-ink-muted);
    text-decoration: none;
    transition: background var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
  }
  .umenu a:hover {
    background: rgba(255, 255, 255, 0.04);
    color: var(--color-ink);
  }
  .uno {
    padding: 8px 10px;
    border-radius: var(--radius-input);
    font-size: 12px;
    color: var(--color-ink-faint);
    cursor: not-allowed;
  }
  .env {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--color-ink-muted);
    border: 1px solid var(--color-edge);
    border-radius: 999px;
    padding: 3px 10px;
  }
  .clock {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--color-ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .content {
    padding: 24px 28px;
    max-width: 1440px;
    width: 100%;
    margin: 0 auto;
    min-width: 0;
  }
  @media (max-width: 1024px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
    }
    .side {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      width: 240px;
      transform: translateX(-100%);
      transition: transform var(--dur-panel) var(--ease-out);
      box-shadow: none;
    }
    .mopen .side {
      transform: none;
      box-shadow: 0 0 64px rgba(0, 0, 0, 0.6);
    }
    .mopen .scrim {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      border: none;
      padding: 0;
      cursor: pointer;
      z-index: 25;
    }
    .ham {
      display: inline-flex;
    }
    .nl,
    .grp-l,
    .bn,
    .hints,
    .cmd kbd,
    .cmd-t,
    .clock {
      display: none;
    }
    .cmd {
      flex: 0 0 auto;
      max-width: none;
      width: 32px;
      height: 32px;
      margin: 0;
      padding: 0;
      justify-content: center;
    }
    .top {
      padding: 0 16px;
      gap: 10px;
    }
    .env {
      display: none;
    }
    .content {
      padding: 16px 20px;
    }
  }
</style>

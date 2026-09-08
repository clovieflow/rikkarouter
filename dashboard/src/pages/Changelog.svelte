<script lang="ts">
  // SCREEN — Changelog (System). Static release notes for v0.1.0: no CHANGELOG
  // file and no git history ship with the dashboard, so entries below describe
  // features verifiable in this repo — never invented dates or versions.
  import Panel from "../components/Panel.svelte";
  import { go } from "../lib/nav.ts";

  interface Entry {
    tag: string;
    title: string;
    desc: string;
    href: string;
    link: string;
  }

  const version = "0.1.0";
  const entries: Entry[] = [
    {
      tag: "Routing",
      title: "Priority-ordered provider routing with cooldown",
      desc: "Requests fan out across connected providers by priority; failed connections enter cooldown and traffic shifts to the next healthy provider automatically.",
      href: "#/routes",
      link: "Open Routes",
    },
    {
      tag: "Providers",
      title: "Provider connections with live health tests",
      desc: "Add providers with API keys, re-test any connection on demand, and read per-connection status, cooldown, and last error from one table.",
      href: "#/providers",
      link: "Open Providers",
    },
    {
      tag: "Control",
      title: "API keys, aliases, and per-key budgets",
      desc: "Issue dashboard keys, map model aliases to targets, and cap spend per key with budget tracking and 80% warnings in the topbar.",
      href: "#/keys",
      link: "Open API Keys",
    },
    {
      tag: "Observability",
      title: "Requests, logs, analytics, and cost rollups",
      desc: "Inspect per-request usage rows, tail the server log, chart traffic by hour, and break spend down by provider and model.",
      href: "#/requests",
      link: "Open Requests",
    },
    {
      tag: "System",
      title: "Status board, settings, and command palette",
      desc: "One global status line from /health plus live connections, local key settings, and a ⌘K palette that jumps to any route.",
      href: "#/status",
      link: "Open Status",
    },
  ];
</script>

<div class="page">
  <header class="phead">
    <div>
      <p class="eyebrow">System · Changelog</p>
      <h2>Changelog</h2>
      <p class="sub">What shipped in this dashboard, version {version}. Entries describe features present in this build — nothing forward-looking.</p>
    </div>
    <span class="ver" title="Dashboard package version">v{version}</span>
  </header>

  <Panel title={`Release v${version} — current build`}>
    <ol class="entries">
      {#each entries as e}
        <li class="entry">
          <span class="tag">{e.tag}</span>
          <div class="body">
            <strong>{e.title}</strong>
            <p>{e.desc}</p>
            <button class="link" onclick={() => go(e.href)}>{e.link} →</button>
          </div>
        </li>
      {/each}
    </ol>
  </Panel>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .phead {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .eyebrow {
    margin: 0 0 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-faint);
  }
  h2 {
    margin: 0;
    font-size: 21px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--color-ink);
  }
  .sub {
    margin: 6px 0 0;
    max-width: 620px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--color-ink-muted);
  }
  .ver {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--color-pink-soft);
    border: 1px solid var(--color-edge-strong);
    background: rgba(255, 22, 140, 0.07);
    border-radius: 999px;
    padding: 3px 12px;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .entry {
    display: flex;
    gap: 14px;
    padding: 14px 4px;
    border-bottom: 1px solid var(--color-edge);
  }
  .entry:last-child {
    border-bottom: none;
  }
  .tag {
    flex-shrink: 0;
    align-self: flex-start;
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-blue-bright);
    border: 1px solid var(--color-edge-strong);
    border-radius: 4px;
    padding: 2px 8px;
    min-width: 86px;
    text-align: center;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .body strong {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--color-ink);
  }
  .body p {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--color-ink-muted);
  }
  .link {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 2px 0 0;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--color-pink-soft);
    cursor: pointer;
  }
  .link:hover {
    color: var(--color-pink);
  }
</style>

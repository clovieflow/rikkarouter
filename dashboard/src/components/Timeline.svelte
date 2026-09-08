<script lang="ts">
  // Timeline (§49): vertical event rail. Tones reuse status hues, dot + text.
  export interface TLItem {
    time?: string;
    title: string;
    desc?: string;
    tone?: "pink" | "blue" | "ok" | "warn" | "bad" | "muted";
  }
  let { items, label = "Timeline" }: { items: TLItem[]; label?: string } = $props();
</script>

<ol class="tl" aria-label={label}>
  {#each items as it, i (i)}
    <li class="ev">
      <span class="dot {it.tone ?? 'muted'}" aria-hidden="true"></span>
      <div class="body">
        <div class="row">
          <span class="title">{it.title}</span>
          {#if it.time}<span class="time">{it.time}</span>{/if}
        </div>
        {#if it.desc}<p class="desc">{it.desc}</p>{/if}
      </div>
    </li>
  {/each}
</ol>

<style>
  .tl {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .ev {
    display: flex;
    gap: 10px;
    position: relative;
    padding: 7px 0 7px 2px;
  }
  .ev:not(:last-child)::before {
    content: "";
    position: absolute;
    left: 5.5px;
    top: 22px;
    bottom: -4px;
    width: 1px;
    background: var(--color-edge);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-top: 4px;
    flex-shrink: 0;
    background: var(--color-ink-faint);
  }
  .dot.pink { background: var(--color-pink); }
  .dot.blue { background: var(--color-blue); }
  .dot.ok { background: var(--color-ok); }
  .dot.warn { background: var(--color-warn); }
  .dot.bad { background: var(--color-bad); }
  .dot.muted { background: var(--color-ink-faint); }
  .body {
    flex: 1;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .title {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--color-ink);
  }
  .time {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--color-ink-faint);
    white-space: nowrap;
  }
  .desc {
    margin: 2px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-ink-muted);
  }
</style>

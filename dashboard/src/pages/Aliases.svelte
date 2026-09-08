<script lang="ts">
  // SCREEN — Aliases: model alias CRUD, the live version of routes today.
  // Alias → provider/model targets set via api.setAlias; curl snippets use
  // location.host so copying works from any machine reaching this server.
  import { onDestroy, onMount } from "svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { api, type AliasRow, type RegistryProvider } from "../lib/api.ts";
  import { copyText } from "../lib/clipboard.ts";

  let aliases = $state<AliasRow[]>([]);
  let registry = $state<RegistryProvider[]>([]);
  let err = $state<string | null>(null);
  let booted = $state(false);

  let alias = $state("");
  let target = $state("");
  let formErr = $state<string | null>(null);
  let busy = $state(false);
  let aliasInput: HTMLInputElement;

  let pendingDel = $state<string | null>(null);
  let copiedAlias = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout>;

  const hints = $derived(registry.flatMap((p) => p.models.map((m) => `${p.id}/${m.id}`)).slice(0, 600));

  const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/i;
  const TARGET_RE = /^[a-z0-9._-]+\/[^\s/]+(\/[^\s/]+)*$/i;

  async function refresh(): Promise<void> {
    try {
      const [a, r] = await Promise.all([api.aliases(), api.registry()]);
      aliases = a.aliases;
      registry = r.providers;
      err = null;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      booted = true;
    }
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const a = alias.trim();
    const t = target.trim();
    if (!ALIAS_RE.test(a)) {
      formErr = "alias must start alphanumeric, then letters, digits, dot, dash or underscore (no “/”).";
      return;
    }
    if (!TARGET_RE.test(t)) {
      formErr = "target must look like provider/model — pick one from the suggestions or type it.";
      return;
    }
    busy = true;
    formErr = null;
    try {
      await api.setAlias(a, t);
      alias = "";
      target = "";
      await refresh();
    } catch (e2) {
      formErr = `set failed: ${(e2 as Error).message}`;
    } finally {
      busy = false;
    }
  }

  function curlFor(a: string): string {
    return `curl http://${location.host}/v1/chat/completions \\\n  -H "authorization: Bearer $RIKKA_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${a}","messages":[{"role":"user","content":"ping"}]}'`;
  }
  async function copyCurl(a: string): Promise<void> {
    const ok = await copyText(curlFor(a));
    if (ok) {
      copiedAlias = a;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copiedAlias = null), 1500);
    } else {
      err = "clipboard blocked by the browser — select the snippet manually once shown";
    }
  }

  async function remove(a: string): Promise<void> {
    try {
      await api.removeAlias(a);
      pendingDel = null;
      await refresh();
    } catch (e) {
      err = (e as Error).message;
    }
  }

  function focusForm(): void {
    aliasInput?.focus();
    aliasInput?.scrollIntoView({ block: "center" });
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    void refresh();
    timer = setInterval(refresh, 6000);
  });
  onDestroy(() => {
    clearInterval(timer);
    clearTimeout(copyTimer);
  });
</script>

<div class="head">
  <div>
    <h1>Aliases</h1>
    <p class="sub">
      {#if !booted}
        loading aliases…
      {:else if err}
        <span class="bad">server unreachable: {err}</span>
        Aliases resolve a short model name → provider/model. For ordered fallback chains with strategies, see Routes.
      {/if}
    </p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Refresh</Button>
    <Button variant="primary" onclick={focusForm}><Icon name="plus" size={13} /> New alias</Button>
  </div>
</div>

<Panel title="Set Alias" sub="applies immediately — clients can request the alias as a model name">
  <form class="aform" onsubmit={(e) => void submit(e)}>
    <label class="fld">
      <span class="lbl">Alias</span>
      <input
        bind:this={aliasInput}
        type="text"
        maxlength="48"
        placeholder="fast"
        autocomplete="off"
        spellcheck="false"
        aria-label="Alias name"
        bind:value={alias}
        oninput={() => (formErr = null)}
      />
    </label>
    <span class="arr" aria-hidden="true">→</span>
    <label class="fld grow">
      <span class="lbl">Target model</span>
      <input
        type="text"
        placeholder="openrouter/meta-llama/llama-3.1-8b-instruct"
        autocomplete="off"
        spellcheck="false"
        aria-label="Target model"
        list="rikka-model-hints"
        bind:value={target}
        oninput={() => (formErr = null)}
      />
    </label>
    <Button type="submit" variant="primary" disabled={busy}><Icon name="aliases" size={13} /> {busy ? "Saving…" : "Set alias"}</Button>
  </form>
  {#if formErr}
    <p class="ferr"><Icon name="bolt" size={12} /> {formErr}</p>
  {:else}
    <p class="fhint">{hints.length ? `target suggestions come from the live registry (${hints.length} models)` : "registry unavailable — type the target directly"}</p>
  {/if}
  <datalist id="rikka-model-hints">
    {#each hints as h (h)}<option value={h}></option>{/each}
  </datalist>
</Panel>

<Panel title="Active Aliases" sub={aliases.length ? "copy a curl snippet per alias · remove is two-step" : "none yet"} pad={false}>
  {#if !booted}
    <div class="skel">
      {#each [0, 1, 2] as i (i)}<div class="sk-row"></div>{/each}
    </div>
  {:else if !aliases.length}
    {#snippet act()}
      <Button variant="primary" onclick={focusForm}><Icon name="plus" size={13} /> Create alias</Button>
    {/snippet}
    <EmptyState
      title="No aliases yet"
      desc="Give clients a stable short name — “fast”, “smart” — that resolves to a concrete provider/model at request time."
      action={act}
    />
  {:else}
    <table class="tbl">
      <thead>
        <tr><th>Alias</th><th></th><th>Target</th><th class="r">Actions</th></tr>
      </thead>
      <tbody>
        {#each aliases as a (a.alias)}
          <tr>
            <td class="mono al">{a.alias}</td>
            <td class="arrow" aria-hidden="true">→</td>
            <td class="mono tg">{a.target}</td>
            <td class="r acts">
              <Button variant="ghost" onclick={() => void copyCurl(a.alias)}>
                <Icon name={copiedAlias === a.alias ? "check" : "copy"} size={12} /> {copiedAlias === a.alias ? "Copied" : "curl"}
              </Button>
              {#if pendingDel === a.alias}
                <Button variant="danger" onclick={() => void remove(a.alias)}><Icon name="trash" size={12} /> Confirm remove</Button>
                <Button variant="ghost" onclick={() => (pendingDel = null)}>Cancel</Button>
              {:else}
                <Button variant="ghost" class="rev" onclick={() => (pendingDel = a.alias)}><Icon name="trash" size={12} /> Remove</Button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</Panel>

<style>
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .sub {
    margin: 3px 0 0;
    font-size: 12.5px;
    color: var(--color-ink-muted);
    max-width: 720px;
  }
  .sub .bad {
    color: var(--color-bad);
  }
  .hdr-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .aform {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .fld.grow {
    flex: 1;
  }
  .lbl {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--color-ink-faint);
    font-weight: 600;
  }
  .fld input {
    height: 32px;
    background: var(--color-elevated);
    border: 1px solid var(--color-edge-strong);
    border-radius: var(--radius-input);
    padding: 0 11px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 12px;
    outline: none;
    width: 100%;
    box-sizing: border-box;
    transition: border-color var(--dur-micro) var(--ease-out);
  }
  .fld input:focus {
    border-color: var(--color-pink);
  }
  .fld input::placeholder {
    color: var(--color-ink-faint);
    font-family: var(--font-mono);
  }
  .arr {
    color: var(--color-blue-bright);
    font-size: 15px;
    padding-bottom: 6px;
  }
  .ferr {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 10px 0 0;
    font-size: 11.5px;
    color: var(--color-bad);
  }
  .fhint {
    margin: 10px 0 0;
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .tbl th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-ink-faint);
    font-weight: 600;
    padding: 9px 16px;
    border-bottom: 1px solid var(--color-edge);
  }
  .tbl td {
    padding: 7px 16px;
    border-bottom: 1px solid rgba(27, 27, 39, 0.5);
    color: var(--color-ink-soft);
  }
  .tbl tbody tr:hover td {
    background: rgba(255, 255, 255, 0.018);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .al {
    color: var(--color-pink);
    font-weight: 600;
  }
  .arrow {
    color: var(--color-blue-bright);
    width: 1%;
  }
  .tg {
    color: var(--color-ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 420px;
  }
  .r {
    text-align: right;
  }
  .acts {
    white-space: nowrap;
  }
  .acts :global(.btn) {
    margin-left: 6px;
  }
  .acts :global(.btn.rev) {
    color: var(--color-ink-muted);
  }
  .acts :global(.btn.rev:hover) {
    color: var(--color-bad);
  }
  .skel {
    padding: 12px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sk-row {
    height: 28px;
    border-radius: var(--radius-ctl);
    background: linear-gradient(180deg, #0b0b11, #0d0d15);
    border: 1px solid var(--color-edge);
    animation: breathe 1.6s var(--ease-out) infinite alternate;
  }
  @keyframes breathe {
    from { opacity: 0.6; }
    to { opacity: 1; }
  }
  @media (max-width: 780px) {
    .aform {
      flex-direction: column;
      align-items: stretch;
    }
    .arr {
      display: none;
    }
    .tg {
      max-width: 180px;
    }
  }
</style>

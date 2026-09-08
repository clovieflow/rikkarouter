<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Panel from "../components/Panel.svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import Input from "../components/Input.svelte";
  import { api } from "../lib/api.ts";

  let health = $state<{ ok: boolean; version?: string; name?: string } | null>(null);
  let err = $state<string | null>(null);
  let booted = $state(false);

  let limits = $state<{ rpmPerKey: number; rpmPerConnection: number } | null>(null);
  let limitsErr = $state<string | null>(null);
  let fKey = $state("0");
  let fConn = $state("0");
  let saveBusy = $state(false);
  let saveMsg = $state<string | null>(null);
  let saveErr = $state<string | null>(null);

  let pwCur = $state("");
  let pwNext = $state("");
  let pwConfirm = $state("");
  let pwBusy = $state(false);
  let pwMsg = $state<string | null>(null);
  let pwErr = $state<string | null>(null);

  let tgToken = $state("");
  let tgChat = $state("");
  let tgOn = $state(false);
  let tgBusy = $state(false);
  let tgMsg = $state<string | null>(null);
  let tgErr = $state<string | null>(null);
  let auditRows = $state<Array<{ seq: number; ts: number; actor: string; action: string; detail: string | null }>>([]);
  async function saveTelegram(): Promise<void> {
    tgBusy = true;
    tgErr = null;
    tgMsg = null;
    try {
      const r = await api.setNotifySettings({ ...(tgToken.trim() ? { botToken: tgToken.trim() } : {}), ...(tgChat.trim() ? { chatId: tgChat.trim() } : {}) });
      tgOn = r.configured;
      tgToken = "";
      tgMsg = r.configured ? "Saved — alerts will fire to Telegram." : "Saved — still missing token or chat id.";
    } catch (e) {
      tgErr = `save failed: ${(e as Error).message}`;
    } finally {
      tgBusy = false;
    }
  }
  async function testTelegram(): Promise<void> {
    tgBusy = true;
    tgErr = null;
    tgMsg = null;
    try {
      const r = await api.testNotify();
      tgMsg = r.ok ? "Test alert sent — check Telegram." : `failed: ${r.error ?? "unknown"}`;
    } catch (e) {
      tgErr = `test failed: ${(e as Error).message}`;
    } finally {
      tgBusy = false;
    }
  }
  async function savePassword(): Promise<void> {
    pwBusy = true;
    pwErr = null;
    pwMsg = null;
    if (pwNext !== pwConfirm) {
      pwErr = "New passwords do not match.";
      pwBusy = false;
      return;
    }
    try {
      await api.changePassword({ current: pwCur, next: pwNext });
      pwCur = "";
      pwNext = "";
      pwConfirm = "";
      pwMsg = "Password updated — other sessions were signed out.";
    } catch (e) {
      pwErr = `save failed: ${(e as Error).message}`;
    } finally {
      pwBusy = false;
    }
  }

  async function refresh() {
    try {
      const r = await api.health();
      health = r;
      err = null;
    } catch (e) {
      err = (e as Error).message;
      health = null;
    } finally { booted = true; }
    try {
      const l = await api.getLimits();
      limits = l;
      fKey = String(l.rpmPerKey);
      fConn = String(l.rpmPerConnection);
      limitsErr = null;
    } catch (e) {
      limitsErr = (e as Error).message;
    }
    try {
      const t = await api.notifySettings();
      tgOn = t.configured;
    } catch {}
    try {
      auditRows = (await api.auditRows(50)).rows;
    } catch {}
  }

  const enforceLabel = $derived(
    !limits ? "loading…" : limits.rpmPerKey > 0 && limits.rpmPerConnection > 0
      ? `enforcing · ${limits.rpmPerKey}/min per key + ${limits.rpmPerConnection}/min per connection`
      : limits.rpmPerKey > 0 ? `enforcing · ${limits.rpmPerKey}/min per key (per-connection off)`
      : limits.rpmPerConnection > 0 ? `enforcing · ${limits.rpmPerConnection}/min per connection (per-key off)`
      : "off · both scopes are 0",
  );

  async function saveLimits(): Promise<void> {
    saveBusy = true;
    saveErr = null;
    saveMsg = null;
    const k = Math.max(0, Math.floor(Number(fKey)));
    const c = Math.max(0, Math.floor(Number(fConn)));
    if (!Number.isFinite(k) || !Number.isFinite(c)) {
      saveErr = "Both fields need a number ≥ 0 (0 disables that scope).";
      saveBusy = false;
      return;
    }
    try {
      const l = await api.setLimits({ rpmPerKey: k, rpmPerConnection: c });
      limits = l;
      fKey = String(l.rpmPerKey);
      fConn = String(l.rpmPerConnection);
      saveMsg = "Saved — new requests are gated immediately.";
    } catch (e) {
      saveErr = `save failed: ${(e as Error).message}`;
    } finally {
      saveBusy = false;
    }
  }
  let timer: ReturnType<typeof setInterval>;
  onMount(() => { void refresh(); timer = setInterval(refresh, 8000); });
  onDestroy(() => clearInterval(timer));
</script>

<div class="head">
  <div>
    <h1>Settings</h1>
    <p class="sub">Server is configured via environment + <code class="mono">~/.rikka/rikka.db</code>. Host/port are set at boot; dashboard is local-only on 127.0.0.1.</p>
  </div>
  <div class="hdr-actions">
    <Button variant="secondary" onclick={() => void refresh()}><Icon name="refresh" size={13} /> Refresh</Button>
  </div>
</div>

{#if !booted}
  <div class="skeleton sk-block"></div>
{:else if err}
  <Panel><p class="bad">server unreachable: {err}</p></Panel>
{:else}
  <Panel title="Server" sub={health ? `rikka ${health.version ?? ""} · local-only` : "running"}>
    <dl class="kv">
      <div><dt>Status</dt><dd>{health?.ok ? "ok" : "unknown"}</dd></div>
      <div><dt>Version</dt><dd class="mono">{health?.version ?? "—"}</dd></div>
      <div><dt>Data dir</dt><dd class="mono">~/.rikka/rikka.db (override via RIKKA_DATA_DIR)</dd></div>
      <div><dt>Host</dt><dd class="mono">127.0.0.1 by default (override HOST)</dd></div>
      <div><dt>Port</dt><dd class="mono">20200 by default (override PORT)</dd></div>
      <div><dt>Auth</dt><dd>API keys gate <code class="mono">/v1</code> · <code class="mono">/api</code> is local-only (127.0.0.1). Front with an authenticating proxy if you expose it.</dd></div>
    </dl>
    <p class="foot">Env at boot: <code class="mono">PORT</code> · <code class="mono">HOST</code> · <code class="mono">RIKKA_DATA_DIR</code> · <code class="mono">RIKKA_DB</code> · <code class="mono">RTK_ENABLED=1</code> (tool-result compression).</p>
  </Panel>
  <Panel title="Defaults" sub="read-only — no settings write API exists">
    <div class="boring">
      <label>Default model<input value="—" disabled title="No settings API — not stored" /></label>
      <label>Request timeout<input value="—" disabled title="No settings API — not stored" /></label>
      <label>Retries<input value="—" disabled title="No settings API — not stored" /></label>
      <label>Log retention<input value="—" disabled title="No settings API — not stored" /></label>
    </div>
    <p class="foot">The server exposes no settings write endpoint, so these fields are disabled and show nothing invented. Configure the server via env at boot (see above) — editable defaults arrive with a settings API.</p>
  </Panel>
  <Panel title="Rate Limits" sub={enforceLabel}>
    {#if limitsErr}
      <p class="bad">limits unreachable: {limitsErr}</p>
      <Button variant="secondary" onclick={() => void refresh()}>Retry</Button>
    {:else if !limits}
      <div class="skeleton sk-lim"></div>
    {:else}
      <div class="limrow">
        <Input bind:value={fKey} label="Requests per minute, per client key (0 disables)" width="120px" />
        <Input bind:value={fConn} label="Requests per minute, per connection (0 disables)" width="120px" />
        <Button variant="primary" onclick={() => void saveLimits()} disabled={saveBusy}>{saveBusy ? "Saving…" : "Save"}</Button>
      </div>
      {#if saveMsg}<p class="okmsg">{saveMsg}</p>{/if}
      {#if saveErr}<p class="bad">{saveErr}</p>{/if}
      <p class="foot">Over-limit <code class="mono">/v1</code> requests fail with <code class="mono">429 rate limit exceeded</code> plus <code class="mono">Retry-After</code> (seconds), <code class="mono">X-RateLimit-Limit</code>, <code class="mono">X-RateLimit-Remaining: 0</code> and <code class="mono">X-RateLimit-Reset</code> headers. Allowed requests also carry the <code class="mono">X-RateLimit-*</code> headers. A scope set to 0 is skipped entirely — never counted, never enforced.</p>
    {/if}
  </Panel>
  <Panel title="Dashboard Lock" sub="password gate before dashboard + api — gateway keys unaffected">
    <div class="limrow">
      <Input bind:value={pwCur} label="Current password (blank on first set)" width="180px" type="password" />
      <Input bind:value={pwNext} label="New password (min 4 chars)" width="180px" type="password" />
      <Input bind:value={pwConfirm} label="Confirm new password" width="180px" type="password" />
      <Button variant="primary" onclick={() => void savePassword()} disabled={pwBusy}>{pwBusy ? "Saving…" : "Save"}</Button>
    </div>
    {#if pwMsg}<p class="okmsg">{pwMsg}</p>{/if}
    {#if pwErr}<p class="bad">{pwErr}</p>{/if}
    <p class="foot">Changing the password signs out every other session immediately. The <code class="mono">RIKKA_DASH_PASSWORD</code> env value always works as a fallback, so you can never lock yourself out.</p>
  </Panel>
  <Panel title="Telegram Alerts" sub={tgOn ? "configured · 429 storms, pool empty, upstream down" : "not configured"}>
    <div class="limrow">
      <Input bind:value={tgToken} label="Bot token (blank keeps stored)" width="220px" type="password" />
      <Input bind:value={tgChat} label="Chat id" width="160px" />
      <Button variant="primary" onclick={() => void saveTelegram()} disabled={tgBusy}>{tgBusy ? "Saving…" : "Save"}</Button>
      <Button variant="secondary" onclick={() => void testTelegram()} disabled={tgBusy}>Send test</Button>
    </div>
    {#if tgMsg}<p class="okmsg">{tgMsg}</p>{/if}
    {#if tgErr}<p class="bad">{tgErr}</p>{/if}
    <p class="foot">Or set <code class="mono">RIKKA_TELEGRAM_BOT_TOKEN</code> + <code class="mono">RIKKA_TELEGRAM_CHAT_ID</code> env. Token is write-only — never displayed back.</p>
  </Panel>
  <Panel title="Admin Audit" sub="who changed what (dashboard actions)">
    {#if !auditRows.length}
      <p class="foot">No admin actions recorded yet — key rotations, proxy edits, password changes and exports land here.</p>
    {:else}
      <ul class="bul">
        {#each auditRows as a (a.seq)}<li><span class="mono">{new Date(a.ts).toLocaleString()}</span> · <b>{a.action}</b>{#if a.detail} — <span class="mono">{a.detail}</span>{/if}</li>{/each}
      </ul>
    {/if}
  </Panel>
  <Panel title="What to set" sub="no config file today — env + DB">
    <ul class="bul">
      <li><code class="mono">npm run dev</code> — watches <code class="mono">src/server/main.ts</code>, live at 127.0.0.1:20200</li>
      <li><code class="mono">npm run build:ui</code> — builds <code class="mono">dist/dashboard</code> (served from same port)</li>
      <li><code class="mono">rikka providers add</code> or dashboard Providers → add an API key; <code class="mono">/api/registry</code> lists the full catalog</li>
      <li>Budgets on <a href="#/policies" class="lnk">Policies</a> cap a key’s monthly USD spend; usage on Costs tracks per-model cost.</li>
    </ul>
  </Panel>
{/if}

<style>
  .head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
  h1 { margin:0; font-size:28px; font-weight:700; letter-spacing:-0.02em; }
  .sub { margin:3px 0 0; font-size:12.5px; color:var(--color-ink-muted); max-width:720px; }
  .sub .mono { font-size:11.5px; }
  .hdr-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .mono { font-family:var(--font-mono); font-size:11.5px; }
  .skeleton { background:linear-gradient(180deg, var(--color-raised), var(--color-elevated)); border:1px solid var(--color-edge); border-radius:var(--radius-panel); animation:breathe 1.6s var(--ease-out) infinite alternate; }
  @keyframes breathe { from{opacity:0.6} to{opacity:1} }
  .sk-block{height:180px}
  .kv{display:grid; gap:10px; margin:0;}
  .kv div{display:grid; grid-template-columns:140px 1fr; gap:12px; align-items:baseline; border-bottom:1px dashed var(--color-edge); padding:8px 0;}
  .kv dt{font-size:10.5px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:var(--color-ink-faint);}
  .kv dd{margin:0; font-size:12.5px; color:var(--color-ink-soft);}
  .kv dd.mono{font-size:11.5px}
  .foot{margin:12px 0 0; font-size:11px; color:var(--color-ink-faint); line-height:1.5}
  .bul{margin:0; padding-left:18px; font-size:12.5px; color:var(--color-ink-soft); line-height:1.6}
  .boring { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }
  @media (max-width: 700px) { .boring { grid-template-columns:1fr; } }
  .boring label { display:flex; flex-direction:column; gap:4px; font-size:10.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:var(--color-ink-faint); }
  .boring input { padding:7px 9px; border:1px solid var(--color-edge); border-radius:6px; background:var(--color-elevated); color:var(--color-ink-faint); font-family:inherit; font-size:12.5px; }
  .boring input:disabled { opacity:0.75; cursor:not-allowed; }
  .lnk{color:var(--color-blue-bright); text-decoration:none}
  .lnk:hover{text-decoration:underline}
  .bad{color:var(--color-bad); font-size:12px}
  .okmsg{color:var(--color-ok); font-size:12px}
  .sk-lim{height:90px}
  .limrow{display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap}
</style>

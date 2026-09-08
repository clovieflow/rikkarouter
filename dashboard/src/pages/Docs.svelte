<script lang="ts">
  import Panel from "../components/Panel.svelte";
</script>

<div class="head">
  <div>
    <p class="crumb">rikka / Docs</p>
    <h1>Docs</h1>
    <p class="sub">Build on this router with any OpenAI-compatible client. One base URL, one key, all providers.</p>
  </div>
</div>

<Panel title="Quickstart" sub="chat completions">
  <p class="dim-note">Point your client at the gateway and use <span class="mono">provider/model</span> ids (full list on the Models page).</p>
  <pre>{`curl http://127.0.0.1:20200/v1/chat/completions \\
  -H "Authorization: Bearer rk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "opencode-zen/glm-5.1",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'`}</pre>
</Panel>

<Panel title="Python (openai package)" sub="drop-in">
<pre>{`from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:20200/v1", api_key="rk_YOUR_KEY")
res = client.chat.completions.create(
    model="opencode-zen/glm-5.1",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(res.choices[0].message.content)`}</pre>
</Panel>

<Panel title="Streaming" sub="server-sent events">
<pre>{`curl -N http://127.0.0.1:20200/v1/chat/completions \\
  -H "Authorization: Bearer rk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "opencode-zen/glm-5.1", "messages": [{"role": "user", "content": "Hi"}], "stream": true}'`}</pre>
  <p class="dim-note">Anthropic (<span class="mono">/v1/messages</span>), Responses (<span class="mono">/v1/responses</span>) and Gemini (<span class="mono">/v1beta/…</span>) wire formats are accepted too — the router translates between them.</p>
</Panel>

<Panel title="Rules of the road" sub="limits & billing">
  <ul class="bul">
    <li>Usage is billed at a flat <b>$0.20 / 1M tokens</b> (input + output) against your key's prepaid balance. Zero balance → <span class="mono">402</span>.</li>
    <li>Per-key rate limits may apply — over-limit calls fail <span class="mono">429</span> with <span class="mono">Retry-After</span>.</li>
    <li>Your key may be restricted to certain models — <span class="mono">403</span> means ask the operator.</li>
    <li>Conversation bodies may be logged for quality and abuse prevention. Export/deletion on request.</li>
    <li>Live status: <a class="lnk" href="/public-status" target="_blank" rel="noreferrer">/public-status</a></li>
  </ul>
</Panel>

<style>
  .head { margin-bottom: 16px; }
  h1 { margin: 0; font-size: 28px; }
  .crumb { font-size: 12px; color: var(--color-ink-faint); margin: 0; }
  .sub { font-size: 12.5px; color: var(--color-ink-muted); margin: 4px 0 0; max-width: 760px; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; font-family: ui-monospace, monospace; background: var(--color-bg); border: 1px solid var(--color-edge); border-radius: 6px; padding: 10px; overflow-x: auto; }
  .mono { font-family: ui-monospace, monospace; font-size: 11.5px; }
  .dim-note { font-size: 11px; color: var(--color-ink-faint); }
  .bul { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.7; }
  .lnk { color: var(--color-blue-bright); }
</style>

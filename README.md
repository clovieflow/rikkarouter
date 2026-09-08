# Rikka Router

<p align="center">
  <strong>High-performance, lightweight local AI coding router & gateway.</strong><br />
  One unified endpoint for OpenAI, Anthropic, and Gemini clients with automatic failover, OAuth engine, and reactive Svelte 5 dashboard.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/framework-Hono-E36002" alt="Hono" />
  <img src="https://img.shields.io/badge/ui-Svelte%205-FF3E00" alt="Svelte 5" />
  <img src="https://img.shields.io/badge/db-node%3Asqlite-blue" alt="SQLite" />
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
</p>

---

## Highlights

- **⚡ Unified Protocol Hub**: Seamlessly accepts OpenAI (`/v1/chat/completions`), Anthropic (`/v1/messages`), Gemini (`/v1beta`), and Responses (`/v1/responses`) wire formats.
- **🔄 Zero-Drop Fallback**: Priority & weighted combos with automatic account rotation on upstream 429 / 5xx. Never drops or duplicates output — failover triggers before the first byte streams to the client.
- **🪶 Single-Process Architecture**: Built on **Hono** and Node's built-in **`node:sqlite`**. Zero external databases (no Postgres/Redis/Docker required to run). Memory footprint < 60MB.
- **🔐 Comprehensive OAuth Engine**: Native support for 19+ OAuth providers via device-code and PKCE authorization code flows (Claude Code, Gemini CLI, GitHub Copilot, Kiro, Antigravity, etc.) with automatic token refresh.
- **🌐 Built-in Proxy Rotation**: Automated proxy pool with latency sorting, quarantine on failure, and transport protection.
- **📊 Reactive Svelte 5 Dashboard**: Route-split, real-time control room, traffic heatmap, route canvas, playground, chat logs with JSONL dataset exporter, and per-key budget limits.
- **🛡️ Security & Multi-Tenancy**: SSRF protection, master dashboard lock, per-key monthly spending caps, and model allowlists.

---

## Installation & Quickstart

### Option A: Install via npm (Recommended — No cloning or `cd` needed)

Install globally directly from GitHub:

```bash
npm install -g github:clovieflow/rikkarouter
```

Then run `rikka` anywhere in your terminal:

```bash
rikka start
```

Or run instantly without installing using `npx`:

```bash
npx github:clovieflow/rikkarouter start
```

---

### Option B: Run from Source (For local development)

```bash
git clone https://github.com/clovieflow/rikkarouter.git
cd rikkarouter
npm install
npm start
```

*The router starts at `http://127.0.0.1:20200` with the web dashboard at `http://127.0.0.1:20200/`.*<br />
*On first boot, Rikka generates a master API key (`rk_...`) and stores its SHA-256 hash in `~/.rikka/rikka.db`.*

---

## Client Integrations

Point your favorite AI coding tools directly to Rikka:

### Claude Code

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:20200"
export ANTHROPIC_API_KEY="rk_your_master_or_client_key"
claude
```

### Cursor / VS Code / OpenAI SDK

- **Base URL**: `http://127.0.0.1:20200/v1`
- **API Key**: `rk_your_master_or_client_key`
- **Model**: `provider/model-id` (e.g. `openrouter/deepseek/deepseek-chat`) or an alias (e.g. `coding`).

### Aider

```bash
aider --openai-api-base http://127.0.0.1:20200/v1 --openai-api-key rk_your_key --model openrouter/deepseek/deepseek-chat
```

---

## CLI Management

Rikka includes a full CLI binary (`rikka`):

```bash
# Provider connections
rikka providers add openrouter sk-or-...     # Add API key connection
rikka providers list                        # List active connections & statuses
rikka providers test <connection-id>        # Health probe upstream

# OAuth connections (Browser & Device flow)
rikka connect claude                        # Authorize Claude Code subscription
rikka connect github                        # Authorize GitHub Copilot device flow

# Client API Keys & Budgets
rikka keys add dev-key                      # Create client key with budget limits
rikka budget set <key-id> 25                # Set $25/month budget cap

# Routing & Combos
rikka aliases set coding claude-3-7-sonnet  # Set model alias
rikka combos add fast-chain groq/llama3 deepseek/deepseek-chat

# Monitoring & Logs
rikka status                                # Server & database health
rikka usage --hours 24                      # Summary of tokens & costs
rikka logs --limit 20                       # Recent request audit log
```

---

## Architecture

```
Clients (Claude Code / Cursor / Aider / cURL)
                     │
                     ▼
     ┌───────────────────────────────┐
     │   Hono Gateway (:20200)       │
     │  /v1/chat    /v1/messages     │
     │  /v1/models  /api/admin       │
     └───────────────┬───────────────┘
                     │
   ┌─────────────────┼─────────────────┐
   ▼                 ▼                 ▼
[Translate]    [Route Resolver]   [Usage & Budget]
OpenAI         Alias → Combo      Per-key limits
Anthropic      Priority Chain     Cost & heatmaps
Gemini         Cooldown Guard     SQLite storage
   │                 │                 │
   └─────────────────┼─────────────────┘
                     ▼
       ┌───────────────────────────┐
       │   Executors & Proxy Pool  │
       │   Single-Flight Refresh   │
       │   SSRF / Egress Guard     │
       └─────────────┬─────────────┘
                     ▼
   Upstream Providers (OpenAI, Anthropic,
   OpenRouter, Gemini, DeepSeek, Groq, etc.)
```

---

## License

Derived in part from [decolua/9router](https://github.com/decolua/9router) (MIT). Distributed under the [MIT License](./LICENSE).

# ⚡ Rikka Router

<p align="center">
  <strong>Ultra-lightweight, zero-config local AI gateway & coding router.</strong><br />
  One unified endpoint for OpenAI, Anthropic, Gemini, and custom LLM providers with automatic failover, single-flight OAuth refresh, built-in proxy pool, and a reactive Svelte 5 dashboard.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen?style=flat-square" alt="Node.js" />
  <img src="https://img.shields.io/badge/framework-Hono-E36002?style=flat-square" alt="Hono" />
  <img src="https://img.shields.io/badge/frontend-Svelte%205-FF3E00?style=flat-square" alt="Svelte 5" />
  <img src="https://img.shields.io/badge/db-node%3Asqlite-blue?style=flat-square" alt="node:sqlite" />
  <img src="https://img.shields.io/badge/catalog-61%20providers%20%7C%20744%20models-purple?style=flat-square" alt="Catalog" />
  <img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License" />
</p>

---

## 📑 Table of Contents

- [Why Rikka?](#-why-rikka)
- [Key Features](#-key-features)
- [Supported Providers & Ecosystem](#-supported-providers--ecosystem)
- [Installation & Quickstart](#-installation--quickstart)
- [Client Integration Guides](#-client-integration-guides)
  - [Claude Code](#claude-code)
  - [Cursor / VS Code (Continue, Cline, Roo Code)](#cursor--vs-code)
  - [Aider](#aider)
  - [Python (OpenAI SDK)](#python-openai-sdk)
  - [Node.js / TypeScript](#nodejs--typescript)
  - [cURL Examples](#curl-examples)
- [Architecture & Mechanics](#-architecture--mechanics)
  - [Zero-Drop Fallback](#zero-drop-fallback)
  - [OAuth Engine & Token Auto-Refresh](#oauth-engine--token-auto-refresh)
  - [Egress Proxy Pool & Quarantine](#egress-proxy-pool--quarantine)
  - [RTK (Real-Time Token Compression)](#rtk-real-time-token-compression)
- [Web Dashboard Overview](#-web-dashboard-overview)
- [CLI Reference](#-cli-reference)
- [API Reference](#-api-reference)
- [Configuration & Environment Variables](#-configuration--environment-variables)
- [License](#-license)

---

## 💡 Why Rikka?

Most developers working with multiple AI coding tools face recurring pain points:
1. **API fragmentation**: Claude Code needs Anthropic format, Cursor needs OpenAI format, Gemini CLI needs Google format.
2. **Fragile rate limits & downtime**: Hitting a 429 quota or 503 error halts coding sessions mid-stream.
3. **Heavy gateway overhead**: Existing proxy solutions often demand Docker containers, Redis, PostgreSQL, and separate auth servers.
4. **Subscription waste**: Developers pay for subscriptions (Claude Pro/Max, GitHub Copilot, Gemini) that cannot easily share quotas or act as fallbacks for each other.

**Rikka solves this in a single Node.js process**:
- **Zero External Dependencies**: Pure TypeScript on Hono and Node's native `node:sqlite`. Boots in **< 15ms**, runs in **< 60MB RAM**.
- **Universal Protocol Adapter**: Ingests requests in OpenAI, Anthropic, Gemini, or Responses format, dynamically translates schemas, and routes to any upstream.
- **True Zero-Drop Fallback**: Switches between accounts, models, or providers seamlessly *before* the first byte reaches the client.
- **Local Privacy**: Your API keys and request logs never leave your machine (`~/.rikka/rikka.db`).

---

## 🚀 Key Features

| Capability | What Rikka Does |
|---|---|
| **Multi-Protocol Translation** | Accepts `/v1/chat/completions`, `/v1/messages`, `/v1beta`, and `/v1/responses`. Cross-translates streaming deltas, tool-use calls, thinking blocks, and usage metadata. |
| **Combos & Priority Chains** | Define fallbacks (e.g. `claude-3-7-sonnet` $\rightarrow$ `gpt-4o` $\rightarrow$ `deepseek-v3`). If the primary hits rate limits, Rikka immediately promotes the secondary. |
| **OAuth 2.0 Engine** | Native support for 19+ OAuth providers via PKCE & Device Flow. Single-flight background token refresh keeps sessions alive with zero latency spike. |
| **Smart Egress Proxy Pool** | Built-in HTTP/SOCKS5 proxy rotation with latency sorting, failure tracking, and automatic quarantine on rate limits. |
| **Reactive Dashboard** | Svelte 5 Single-Page App with live control room, interactive route canvas, latency sparklines, playground, and dataset exports. |
| **Enterprise Multi-Tenancy** | Generate client API keys (`rk_...`) with monthly USD budget caps, model allowlists, and IP restrictions. |
| **SSRF & Security Shield** | Private IP egress blocking on proxies and webhooks, password-protected dashboard with loopback bypass. |

---

## 🌐 Supported Providers & Ecosystem

Rikka ships with a validated catalog of **61 providers and 744 models**:

### API-Key Providers
- **Major Labs**: OpenAI, Anthropic, Google Gemini API, xAI (Grok), Mistral AI.
- **Inference Platforms**: OpenRouter, Groq, Cerebras, Together AI, Fireworks AI, SiliconFlow, DeepSeek, Featherless, DeepInfra, Novita, Replicate.
- **Specialized & Regional**: MiniMax, 01.AI (Yi), Baichuan, Moonshot (Kimi), Qwen (DashScope), Zhipu GLM, Hunyuan, StepFun.

### OAuth-Enabled Providers (19 Flows Supported)
Directly connect your developer subscriptions and IDE accounts via CLI or Dashboard:
- `claude` (Claude Code subscription)
- `github` (GitHub Copilot device flow)
- `gemini-cli` (Google Gemini CLI OAuth)
- `codex` (OpenAI Codex platform)
- `kiro` (AWS SSO OIDC Device Flow)
- `antigravity` (Google Code Assist)
- `gitlab`, `grok-cli`, `iflow`, `kimi`, `kilocode`, `cline`, `clinepass`, `kimchi`, `codebuddy-cn`, `codebuddy-intl`, `qoder`, `zed`, `xai`

---

## 📦 Installation & Quickstart

### Option 1: Global Install via npm (Recommended)

Install globally from GitHub:

```bash
npm install -g github:clovieflow/rikkarouter
```

Start the router anywhere in your terminal:

```bash
rikka start
```

### Option 2: Instant Run via `npx` (No Install)

```bash
npx github:clovieflow/rikkarouter start
```

### Option 3: Run from Source

```bash
git clone https://github.com/clovieflow/rikkarouter.git
cd rikkarouter
npm install
npm start
```

Once started:
- **API Gateway**: `http://127.0.0.1:20200`
- **Web Dashboard**: `http://127.0.0.1:20200/` *(default password in `.env` or set via `RIKKA_DASH_PASSWORD`)*
- **Data Location**: `~/.rikka/rikka.db`

---

## 🔌 Client Integration Guides

### Claude Code

Point the official Claude Code CLI to your local Rikka instance:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:20200"
export ANTHROPIC_API_KEY="rk_your_key_here"

# Run Claude Code normally
claude
```

### Cursor / VS Code

In Cursor or VS Code extensions (Continue, Roo Code, Cline):

1. **OpenAI Compatible Endpoint**:
   - **Base URL**: `http://127.0.0.1:20200/v1`
   - **API Key**: `rk_your_key_here`
   - **Model Name**: Any provider model (e.g. `openrouter/deepseek/deepseek-chat`) or an alias (e.g. `coding`).

2. **Anthropic Compatible Endpoint**:
   - **Base URL**: `http://127.0.0.1:20200`
   - **API Key**: `rk_your_key_here`
   - **Model Name**: `claude-3-7-sonnet` (or aliases mapped to Anthropic).

### Aider

```bash
aider \
  --openai-api-base http://127.0.0.1:20200/v1 \
  --openai-api-key rk_your_key_here \
  --model openrouter/deepseek/deepseek-chat
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:20200/v1",
    api_key="rk_your_key_here"
)

response = client.chat.completions.create(
    model="coding",  # Uses your configured alias or fallback combo
    messages=[{"role": "user", "content": "Write a fast prime sieve in Rust."}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### Node.js / TypeScript

```typescript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://127.0.0.1:20200/v1",
  apiKey: "rk_your_key_here",
});

const stream = await openai.chat.completions.create({
  model: "claude-3-7-sonnet",
  messages: [{ role: "user", content: "Explain CRDTs in simple terms." }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

### cURL Examples

**Streaming Chat Completion (OpenAI format):**
```bash
curl -X POST http://127.0.0.1:20200/v1/chat/completions \
  -H "Authorization: Bearer rk_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-chat",
    "messages": [{"role": "user", "content": "Hello Rikka!"}],
    "stream": true
  }'
```

**Messages API with Thinking Tokens (Anthropic format):**
```bash
curl -X POST http://127.0.0.1:20200/v1/messages \
  -H "x-api-key: rk_your_key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-7-sonnet",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Analyze time complexity of quicksort."}]
  }'
```

---

## 🏗️ Architecture & Mechanics

```
Clients (Claude Code / Cursor / Aider / SDKs)
                     │
                     ▼
     ┌───────────────────────────────┐
     │      Hono Gateway (:20200)    │
     │  /v1/chat       /v1/messages  │
     │  /v1beta        /v1/responses │
     └───────────────┬───────────────┘
                     │
   ┌─────────────────┼─────────────────┐
   ▼                 ▼                 ▼
[Protocol Translators] [Route & Fallback] [Usage & Budgeting]
OpenAI Wire            Alias Resolution   Monthly USD Caps
Anthropic Wire         Combo Chains       Token Extraction
Gemini Wire            Cooldown Engine    SQLite Event Stream
   │                 │                 │
   └─────────────────┼─────────────────┘
                     ▼
       ┌───────────────────────────┐
       │     Egress & Proxy Engine │
       │   Single-Flight Refresh   │
       │   SSRF / Private IP Guard │
       │   Rotating Proxy Pool     │
       └─────────────┬─────────────┘
                     ▼
   Upstream Providers (Anthropic, OpenAI,
   DeepSeek, OpenRouter, Groq, Gemini, etc.)
```

### Zero-Drop Fallback
When streaming AI responses, naive routers often failover *after* sending partial chunks to the client, leading to broken JSON or duplicate half-responses.
Rikka's streaming gateway captures and verifies the first byte of upstream response inside a memory buffer. If an upstream failure (429, 502, 503, connection reset) occurs before the first chunk is flushed:
1. The failing candidate is placed in quarantine with an exponential backoff.
2. The request seamlessly pivots to the next candidate in the combo chain.
3. The client never observes an error or disconnected stream.

### OAuth Engine & Token Auto-Refresh
Rikka includes a native implementation of PKCE and device authorization flows. When access tokens approach expiration:
- An async **single-flight lock** deduplicates incoming requests.
- Exactly one refresh HTTP call is dispatched to upstream servers.
- The new token and expiry are atomically committed to `~/.rikka/rikka.db`.
- All waiting client requests proceed immediately with the fresh token.

### Egress Proxy Pool & Quarantine
- **Auto-Rotation**: Distributes traffic across healthy proxies with priority sorting (private lists at priority 10, free lists at 100).
- **Transient Quarantine**: Provider 429 rate limits quarantine the proxy IP without destroying it, while transport socket failures increment fail counts toward eviction.
- **Credential Masking**: Proxy usernames and passwords are encrypted and never exposed to the client or dashboard.

### RTK (Real-Time Token Compression)
When active (`RTK_ENABLED=1`), Rikka intercepts voluminous tool outputs (such as `git diff`, `grep`, or directory listings) and performs lossless redundancy compression before forwarding to LLM models, saving up to **30–45%** of context window tokens.

---

## 🖥️ Web Dashboard Overview

Rikka includes a single-page dashboard built with **Svelte 5** (route-split into a lightweight ~40KB gzip entry chunk):

- **Control Room (Overview)**: Real-time request flow canvas, failover events, active connections, and latency telemetry.
- **Route Canvas**: Visual drag-and-drop builder for fallback chains, priority queues, and weighted load balancing.
- **Interactive Playground**: Test prompt completions across providers simultaneously, compare latency, and inspect trace logs.
- **Chats & Dataset Export**: Full request body inspection with one-click JSONL export for fine-tuning or distillation.
- **Analytics & Costs**: Per-model and per-key usage breakdown, hourly request heatmaps, and USD cost trends.
- **Proxies & Health Radar**: Monitor proxy pool latency, quarantine states, and upstream provider status.

---

## 🛠️ CLI Reference

The `rikka` binary provides comprehensive management commands:

```bash
# Gateway lifecycle
rikka start                                # Launch the server on :20200
rikka status                               # Check database & daemon health

# Provider Connections
rikka providers list                       # View all connections and statuses
rikka providers add <provider> <apiKey>    # Add an API key connection
rikka providers rm <connectionId>          # Delete a connection
rikka providers test <connectionId>        # Live health probe against upstream

# OAuth Connections
rikka connect <provider>                   # Launch browser / device authorization
# Supported: claude, github, gemini-cli, codex, kiro, antigravity, grok-cli, etc.

# API Keys & Budgets
rikka keys list                            # List client API keys
rikka keys add <name>                      # Generate new client key (rk_...)
rikka keys rm <keyId>                      # Revoke an API key
rikka budget set <keyId> <usdAmount>       # Set monthly budget limit in USD
rikka budget get <keyId>                   # View current month spend vs cap

# Model Aliases & Combos
rikka aliases list                         # List current aliases
rikka aliases set <alias> <targetModel>    # e.g. rikka aliases set coding claude-3-7-sonnet
rikka aliases rm <alias>                   # Delete an alias
rikka combos list                          # List multi-provider fallback combos
rikka combos add <name> <model1> <model2>  # Create priority fallback chain

# Logs & Observability
rikka usage [--hours 24]                   # Summarize token count & cost totals
rikka logs [--limit 50] [--key <id>]       # View recent request audit log
```

---

## 📡 API Reference

### Gateway Protocol Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | Standard OpenAI chat completion (streaming & non-streaming) |
| `POST` | `/v1/messages` | Anthropic Messages API (with thinking blocks & tool calls) |
| `POST` | `/v1/messages/count_tokens` | Token counter for Anthropic payloads |
| `POST` | `/v1beta/models/*` | Gemini generation format adapter |
| `POST` | `/v1/responses` | OpenAI Responses protocol |
| `GET`  | `/v1/models` | List all available models across connected providers |
| `GET`  | `/health` | Health check endpoint (`{"ok": true}`) |

### Admin Management API

*All `/api/*` endpoints are open on loopback for the CLI and local dashboard, and protected by password lock on external interfaces.*

| Method | Endpoint | Description |
|---|---|---|
| `GET/POST` | `/api/providers` | List or add provider connections |
| `DELETE` | `/api/providers/:id` | Remove a connection |
| `GET/POST` | `/api/keys` | List or generate client API keys |
| `DELETE` | `/api/keys/:id` | Revoke a client API key |
| `GET/PUT/DELETE` | `/api/aliases/:name` | Manage model aliases |
| `GET/POST/DELETE` | `/api/combos` | Manage fallback combo chains |
| `GET` | `/api/usage/summary` | Aggregate token and cost usage statistics |
| `GET` | `/api/chats` | Retrieve conversation turn history |
| `POST` | `/api/chats/export` | Export filtered conversation dataset as JSONL |
| `GET/POST/DELETE` | `/api/proxy` | Manage proxy pool, labels, and priorities |
| `POST` | `/api/proxy/refresh` | Trigger free-list proxy refresh and probe |

---

## ⚙️ Configuration & Environment Variables

Rikka runs with zero configuration by default. You can customize behavior using environment variables or a `.env` file:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `20200` | Port for the HTTP gateway and web dashboard |
| `HOST` | `127.0.0.1` | Network interface to bind (`0.0.0.0` for LAN/remote access) |
| `RIKKA_DATA_DIR` | `~/.rikka` | Directory where `rikka.db` and machine keys are stored |
| `RIKKA_DASH_PASSWORD` | `123456` | Password required to unlock the web dashboard |
| `RTK_ENABLED` | `0` | Set to `1` to enable real-time tool output token compression |
| `RIKKA_LOG_BODIES` | `1` | Store request/response bodies in database (`0` for metadata only) |
| `RIKKA_FLAT_PRICING_USD_PER_M` | `0.2` | Fallback pricing per 1M tokens when model pricing is unlisted |
| `RIKKA_TELEGRAM_BOT_TOKEN` | *None* | Optional Telegram bot token for alert notifications |
| `RIKKA_TELEGRAM_CHAT_ID` | *None* | Optional Telegram chat ID for alert notifications |

---

## 📄 License

Rikka Router is open-source software licensed under the [MIT License](./LICENSE).

*Derived in part from [decolua/9router](https://github.com/decolua/9router) (MIT).*

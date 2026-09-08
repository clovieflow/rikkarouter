// Model-string routing: "prov/model" | alias | combo | bare model → ordered candidates.
import { randomUUID } from "node:crypto";
import type { CanonicalRequest, Credential, WireFormat } from "./types.ts";
import { openaiToCanonical } from "./translate/openai.ts";
import type { OpenAIChatRequest } from "./types.ts";
import { anthropicToCanonical } from "./translate/anthropic.ts";
import type { AnthropicRequest } from "./translate/anthropic.ts";
import { geminiToCanonical } from "./translate/gemini.ts";
import type { GeminiRequest } from "./translate/gemini.ts";
import { responsesToCanonical } from "./translate/responses.ts";
import type { ResponsesRequest } from "./translate/responses.ts";
import { providerById, providerByAlias, PROVIDERS, type ProviderDef } from "./providers/registry.ts";
import { getAlias, getCombo, getModelsCache, listConnections, usableConnections, type ConnectionRow } from "../shared/db.ts";

export class RouteError extends Error {
  override name = "RouteError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Candidate {
  provider: ProviderDef;
  connection: ConnectionRow;
  /** upstream model id */
  model: string;
}

function findProvider(token: string): ProviderDef | undefined {
  return providerByAlias(token) ?? providerById(token);
}

// Round-robin start offset per provider: N keys for one provider share load
// proactively instead of key #2 idling until key #1 429s. Failover order is
// preserved — only the starting point rotates.
const rrCursor = new Map<string, number>();
function rotated<T>(conns: T[], key: string): T[] {
  if (conns.length < 2) return conns;
  const start = (rrCursor.get(key) ?? 0) % conns.length;
  rrCursor.set(key, start + 1);
  return [...conns.slice(start), ...conns.slice(0, start)];
}

/**
 * Final combo name for a requested string: strips `combo:`/`combo-writer:`
 * prefixes, then follows the alias chain. Usage/request_log keep the combo
 * label even when the client addressed the combo through an alias.
 */
function comboNameFor(requested: string): string | undefined {
  let cur = requested;
  const seen: string[] = [];
  for (;;) {
    if (cur.startsWith("combo-writer:")) {
      cur = cur.slice("combo-writer:".length);
      if (!cur) return undefined;
      continue;
    }
    if (cur.startsWith("combo:")) {
      cur = cur.slice("combo:".length);
      if (!cur) return undefined;
      continue;
    }
    if (seen.includes(cur)) return undefined;
    seen.push(cur);
    const target = getAlias(cur);
    if (target !== undefined && target !== cur) {
      cur = target;
      continue;
    }
    break;
  }
  const combo = getCombo(cur);
  if (combo && combo.enabled) return cur;
  return undefined;
}

export function resolve(requested: string, _seen = new Set<string>()): Candidate[] {
  // Support 9router alias syntax: combo-writer:<name> or combo:<name> → treat <name> as combo
  const comboPrefix = requested.startsWith("combo-writer:") ? "combo-writer:" : requested.startsWith("combo:") ? "combo:" : null;
  if (comboPrefix) {
    const bare = requested.slice(comboPrefix.length);
    if (bare) return resolve(bare, _seen);
  }
  if (_seen.has(requested)) throw new RouteError(400, `circular alias/combo: ${requested}`);
  _seen.add(requested);

  const aliasHit = getAlias(requested);
  if (aliasHit && aliasHit !== requested) {
    // Alias target may itself be combo-writer: syntax → recurse will handle prefix
    return resolve(aliasHit, _seen);
  }

  const combo = getCombo(requested);
  if (combo && combo.enabled) {
    let steps: Array<{ model: string; weight?: number }> = [];
    try {
      steps = JSON.parse(combo.steps) as typeof steps;
    } catch {
      throw new RouteError(500, `combo "${requested}" has invalid steps JSON`);
    }
    if (!steps.length) throw new RouteError(400, `combo "${requested}" has no steps`);
    const tagged: Array<{ cand: Candidate; weight: number }> = [];
    for (const s of steps) {
      if (!s.model) continue;
      try {
        const expanded = resolve(s.model, new Set(_seen));
        // Weight rides on the resolved candidates (alias/bare/combo steps are
        // already expanded above), never on the raw step strings.
        const weight = s.weight ?? 1;
        for (const cand of expanded) tagged.push({ cand, weight });
      } catch (e) {
        // Step has no usable connections (e.g. provider in cooldown) — skip it and try next step
        if (e instanceof RouteError && e.status === 400 && String(e.message).includes("not connected")) continue;
        throw e;
      }
    }
    if (!tagged.length) throw new RouteError(400, `combo "${requested}" has no usable connections`);
    if (combo.strategy === "weighted") {
      tagged.sort((a, b) => (b.weight - a.weight) || (a.cand.provider.priority - b.cand.provider.priority));
    }
    return tagged.map((t) => t.cand);
  }

  const slash = requested.indexOf("/");
  if (slash > 0) {
    const provToken = requested.slice(0, slash);
    const model = requested.slice(slash + 1);
    const provider = findProvider(provToken);
    if (!provider) {
      throw new RouteError(404, `unknown provider "${provToken}" in model "${requested}" (try "prov/model", see /v1/models)`);
    }
    const conns = rotated(usableConnections(provider.id), `prov:${provider.id}`);
    if (!conns.length) {
      throw new RouteError(400, `provider "${provider.id}" not connected — add an API key via /api/providers or \`rikka providers add\``);
    }
    return conns.map((connection) => ({ provider, connection, model }));
  }

  const matches: Candidate[] = [];
  const bareLower = requested.toLowerCase();
  const providers: ProviderDef[] = [...PROVIDERS];
  for (const row of listConnections()) {
    if (providers.some((p) => p.id === row.provider)) continue;
    const def = providerById(row.provider);
    if (def !== undefined) providers.push(def);
  }
  for (const provider of providers) {
    const conns = rotated(usableConnections(provider.id), `prov:${provider.id}`);
    if (!conns.length) continue;
    if (provider.models.some((m) => m.id.toLowerCase() === bareLower)) {
      for (const connection of conns) matches.push({ provider, connection, model: requested });
      continue;
    }
    // Live-detected models (per-connection cache) are addressable without a prefix.
    for (const connection of conns) {
      const cached = getModelsCache(connection.id);
      if (cached.models.some((m) => m.id.toLowerCase() === bareLower)) {
        matches.push({ provider, connection, model: requested });
      }
    }
  }

  if (!matches.length) {
    throw new RouteError(
      404,
      `model "${requested}" not found — use "provider/model" (e.g. "openrouter/deepseek/deepseek-chat") or list /v1/models`,
    );
  }
  return matches.sort((a, b) => a.provider.priority - b.provider.priority);
}

export interface Resolved {
  request: CanonicalRequest;
  candidates: Candidate[];
  requested: string;
  format: WireFormat;
  combo?: string;
}

export function resolveChat(body: OpenAIChatRequest): Resolved {
  if (typeof body.model !== "string" || !body.model) {
    throw new RouteError(400, "missing `model` in request body");
  }
  const candidates = resolve(body.model);
  const canonical = openaiToCanonical(body);
  const comboName = comboNameFor(body.model);
  return {
    request: { ...canonical, model: candidates[0]?.model ?? body.model },
    candidates,
    requested: body.model,
    format: "openai",
    ...(comboName ? { combo: comboName } : {}),
  };
}

export function resolveMessages(body: AnthropicRequest): Resolved {
  if (typeof body.model !== "string" || !body.model) {
    throw new RouteError(400, "missing `model` in request body");
  }
  const candidates = resolve(body.model);
  const canonical = anthropicToCanonical(body);
  const comboName = comboNameFor(body.model);
  return {
    request: { ...canonical, model: candidates[0]?.model ?? body.model },
    candidates,
    requested: body.model,
    format: "anthropic",
    ...(comboName ? { combo: comboName } : {}),
  };
}

export function resolveGemini(body: GeminiRequest, modelFromUrl?: string): Resolved {
  const model = modelFromUrl ?? (body as unknown as { model?: string }).model ?? "gemini-pro";
  (body as unknown as Record<string, unknown>).model = model;
  const candidates = resolve(model);
  const canonical = geminiToCanonical(body);
  const comboName = comboNameFor(model);
  return {
    request: { ...canonical, model: candidates[0]?.model ?? model },
    candidates,
    requested: model,
    format: "gemini",
    ...(comboName ? { combo: comboName } : {}),
  };
}

export function resolveResponses(body: ResponsesRequest): Resolved {
  const model = body.model;
  if (typeof model !== "string" || !model) throw new RouteError(400, "missing `model` in request body");
  const candidates = resolve(model);
  const canonical = responsesToCanonical(body);
  const comboName = comboNameFor(model);
  return {
    request: { ...canonical, model: candidates[0]?.model ?? model },
    candidates,
    requested: model,
    format: "responses",
    ...(comboName ? { combo: comboName } : {}),
  };
}

export function credentialFor(c: Candidate): Credential {
  let headers: Record<string, string> | undefined;
  if (c.connection.headers) {
    try {
      headers = JSON.parse(c.connection.headers) as Record<string, string>;
    } catch {
      headers = undefined;
    }
  }
  return {
    connectionId: c.connection.id,
    apiKey: c.connection.api_key,
    ...(c.connection.base_url ? { baseUrlOverride: c.connection.base_url } : {}),
    ...(headers ? { headers } : {}),
    ...(c.connection.proxy_url ? { proxyUrl: c.connection.proxy_url } : {}),
  };
}

export function newId(prefix = "con"): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

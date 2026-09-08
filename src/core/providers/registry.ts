// Provider registry — data-driven catalog.
// W1/W2/W3 entries derived from decolua/9router registry data (MIT) — see NOTICE.
import w1 from "./w1.json" with { type: "json" };
import w2 from "./w2.json" with { type: "json" };
import w3 from "./w3.json" with { type: "json" };
export type ProviderFormat = "openai" | "anthropic" | "gemini";

export interface ModelDef {
  id: string;
  name: string;
  /** upstream wire format override — e.g. models that only serve the Responses API */
  format?: "openai" | "responses";
}

export interface ProviderDef {
  id: string;
  name: string;
  /** short prefix used in model strings, e.g. "glm/claude-x" */
  alias: string;
  format: ProviderFormat;
  baseUrl: string;
  validateUrl?: string;
  apiKeyUrl?: string;
  website?: string;
  color?: string;
  /** bearer = Authorization: Bearer; combined = value already carries scheme */
  authStyle: "bearer" | "combined";
  headers?: Record<string, string>;
  models: ModelDef[];
  priority: number;
  free: boolean;
  experimental?: boolean;
  /** auth kind: apikey now; oauth lands in Phase 4 */
  authType: "apikey" | "oauth";
  /** requires MITM proxy (cursor/windsurf/trae) — not supported via OAuth UI */
  requiresMitm?: boolean;
}

type W1Entry = {
  id: string;
  name: string;
  alias: string;
  website?: string;
  apiKeyUrl?: string;
  color?: string;
  baseUrl: string;
  validateUrl?: string;
  headers?: Record<string, string>;
  authStyle: "bearer" | "combined";
  models: ModelDef[];
  priority: number;
  free: boolean;
  requiresMitm?: boolean;
  experimental?: boolean;
};
/** normalize a raw extracted entry into a ProviderDef. */
function normalize(e: W1Entry, format: "openai" | "anthropic"): ProviderDef {
  return {
    id: e.id,
    name: e.name,
    alias: e.alias,
    format,
    baseUrl: e.baseUrl.replace(/\/*$/, ""),
    ...(e.validateUrl ? { validateUrl: e.validateUrl } : {}),
    ...(e.apiKeyUrl ? { apiKeyUrl: e.apiKeyUrl } : {}),
    ...(e.website ? { website: e.website } : {}),
    ...(e.color ? { color: e.color } : {}),
    authStyle: e.authStyle,
    ...(e.headers ? { headers: e.headers } : {}),
    models: e.models,
    priority: e.priority,
    free: e.free,
    experimental: e.experimental ?? e.models.length === 0,
    authType: "apikey",
    ...(e.requiresMitm || ["cursor", "windsurf", "trae"].includes(e.id) ? { requiresMitm: true } : {}),
  };
}

type W3Entry = W1Entry & { format: "openai" | "anthropic"; authType: "oauth" };
function normalizeOAuth(e: W3Entry): ProviderDef {
  return {
    id: e.id,
    name: e.name,
    alias: e.alias,
    format: e.format,
    baseUrl: e.baseUrl.replace(/\/*$/, ""),
    ...(e.website ? { website: e.website } : {}),
    ...(e.color ? { color: e.color } : {}),
    authStyle: e.authStyle,
    ...(e.headers ? { headers: e.headers } : {}),
    models: e.models,
    priority: e.priority,
    free: e.free,
    experimental: (e as W1Entry).experimental ?? e.models.length === 0,
    authType: "oauth",
    ...(((e as W1Entry).requiresMitm || ["cursor", "windsurf", "trae"].includes(e.id)) ? { requiresMitm: true } : {}),
  };
}

const w1Ids = new Set((w1 as W1Entry[]).map((e) => e.id));
const w1w2Ids = new Set([...w1Ids, ...(w2 as W1Entry[]).map((e) => e.id)]);
export const PROVIDERS: ProviderDef[] = [
  ...(w1 as W1Entry[]).map((e) => normalize(e, "openai")),
  ...(w2 as W1Entry[]).filter((e) => !w1Ids.has(e.id)).map((e) => normalize(e, "anthropic")),
  ...(w3 as W3Entry[]).filter((e) => !w1w2Ids.has(e.id)).map((e) => normalizeOAuth(e)),
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));
const byAlias = new Map(PROVIDERS.map((p) => [p.alias.toLowerCase(), p]));

export function providerById(id: string): ProviderDef | undefined {
  const known = byId.get(id);
  if (known) return known;
  // Custom endpoints: `custom-<slug>` synthesizes an OpenAI-compatible
  // definition. The real base URL must come from the connection row
  // (base_url override); models are addressed verbatim: custom-slug/any-model.
  if (id.startsWith("custom-") && /^[a-z0-9][a-z0-9-]*$/.test(id)) {
    const slug = id.slice("custom-".length);
    const name = slug.split("-").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
    return {
      id,
      name: `${name} (custom)`,
      alias: id,
      format: "openai",
      baseUrl: "",
      authStyle: "bearer",
      models: [],
      priority: 999,
      free: false,
      authType: "apikey",
    };
  }
  return undefined;
}

/** Upstream wire format for one model — registry override wins, else the provider default. */
export function modelFormat(provider: ProviderDef, modelId: string): "openai" | "responses" | undefined {
  const bare = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  for (const m of provider.models) {
    if (m.id === modelId || m.id === bare) return m.format;
  }
  return undefined;
}
export function providerByAlias(alias: string): ProviderDef | undefined {
  return byAlias.get(alias.toLowerCase());
}

export function allModels(): Array<{ id: string; provider: string; name: string }> {
  return PROVIDERS.flatMap((p) => p.models.map((m) => ({ id: `${p.id}/${m.id}`, provider: p.id, name: m.name })));
}

/** Providers with at least one live connection + usable by default. */
export function recommendedProviders(connected: Set<string>): ProviderDef[] {
  return PROVIDERS.filter((p) => connected.has(p.id) && !p.experimental).sort((a, b) => a.priority - b.priority);
}

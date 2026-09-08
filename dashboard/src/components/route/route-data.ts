// Shared route-domain helpers: step parsing, strategy catalog, usage attribution,
// rule compilation, and local drafts. No UI here — single source for Routes,
// RouteDetail, canvas, builder, and Playground.
import type { Combo, UsageRow, AliasRow } from "../../lib/api.ts";

export interface Step {
  model: string;
  weight?: number;
}

/** Parse the server's steps field (array, JSON string, or legacy string[]). */
export function parseSteps(raw: unknown): Step[] {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") {
    try {
      const p: unknown = JSON.parse(raw);
      if (Array.isArray(p)) arr = p;
    } catch {
      return [];
    }
  }
  const out: Step[] = [];
  for (const s of arr) {
    if (typeof s === "string") {
      if (s.trim()) out.push({ model: s.trim() });
    } else if (s && typeof s === "object" && typeof (s as { model?: unknown }).model === "string") {
      const m = (s as { model: string }).model.trim();
      if (!m) continue;
      const w = (s as { weight?: unknown }).weight;
      out.push(typeof w === "number" && Number.isFinite(w) && w > 0 ? { model: m, weight: w } : { model: m });
    }
  }
  return out;
}

export function stepLabel(s: Step): string {
  return s.weight != null ? `${s.model} (w ${s.weight})` : s.model;
}

/** First step = primary; rest = fallback chain. */
export function primaryOf(steps: Step[]): Step | null {
  return steps.length ? steps[0]! : null;
}
export function fallbacksOf(steps: Step[]): Step[] {
  return steps.slice(1);
}

// ── strategies (§19) ──────────────────────────────────────────────
// The gateway only executes two: "priority" (step order) and "weighted"
// (weight-desc, see src/core/routing.ts). Everything else is stored on the
// combo as a preference and labeled advisory — never silently mapped.

export interface StrategyDef {
  id: string;
  name: string;
  desc: string;
  gateway: boolean;
}

export const STRATEGIES: StrategyDef[] = [
  { id: "priority", name: "Priority", desc: "Try steps in order; first success wins. The only ordering the gateway executes besides weighted.", gateway: true },
  { id: "weighted", name: "Weighted", desc: "Sort steps by weight descending, then connection priority. Executed by the gateway.", gateway: true },
  { id: "lowest-cost", name: "Lowest cost", desc: "Prefer the cheapest step first. Advisory — gateway still executes priority order.", gateway: false },
  { id: "lowest-latency", name: "Lowest latency", desc: "Prefer the fastest step first. Advisory — gateway still executes priority order.", gateway: false },
  { id: "highest-reliability", name: "Highest reliability", desc: "Prefer the most reliable step first. Advisory — gateway still executes priority order.", gateway: false },
  { id: "smart", name: "Smart", desc: "Capability-aware pick (vision/audio float first). Advisory — gateway only auto-switches hard capabilities.", gateway: false },
  { id: "custom", name: "Custom", desc: "RuleBuilder output: static order compiled from IF/AND/THEN rules. Executed as priority order.", gateway: false },
];

export function strategyDef(id: string | null | undefined): StrategyDef {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0]!;
}
export function isGatewayStrategy(id: string | null | undefined): boolean {
  return strategyDef(id).gateway;
}

// ── usage attribution ─────────────────────────────────────────────
// /api/usage groups by provider×model with no combo column, so a route's
// stats are attributed by matching its steps' provider/model against rows.
// Steps that are aliases are expanded one level via the alias map.

export interface RouteStats {
  reqs: number;
  ok: number;
  success: number | null;
  avgMs: number | null;
  inp: number;
  outp: number;
  cost: number;
  matched: boolean;
}

export function expandStepModels(steps: Step[], aliases: AliasRow[]): Set<string> {
  const aliasMap = new Map(aliases.map((a) => [a.alias, a.target]));
  const set = new Set<string>();
  for (const s of steps) {
    const t = aliasMap.get(s.model) ?? s.model;
    const slash = t.indexOf("/");
    if (slash > 0) set.add(t);
    else set.add(`*/${t.toLowerCase()}`);
  }
  return set;
}

export function attributeUsage(steps: Step[], rows: UsageRow[], aliases: AliasRow[]): RouteStats {
  const models = expandStepModels(steps, aliases);
  let reqs = 0, ok = 0, inp = 0, outp = 0, cost = 0, wsum = 0, wms = 0;
  let matched = false;
  for (const r of rows) {
    const key = `${r.provider}/${r.model}`;
    const bare = `*/${r.model.toLowerCase()}`;
    if (!models.has(key) && !models.has(bare)) continue;
    matched = true;
    reqs += r.n;
    ok += r.ok_n ?? 0;
    inp += r.inp ?? 0;
    outp += r.outp ?? 0;
    cost += (r as UsageRow & { cost?: number }).cost ?? 0;
    if (r.avg_ms != null) {
      wsum += r.n;
      wms += r.avg_ms * r.n;
    }
  }
  return {
    reqs, ok,
    success: reqs ? ok / reqs : null,
    avgMs: wsum ? wms / wsum : null,
    inp, outp, cost, matched,
  };
}

export function routeStatus(c: Combo, steps: Step[]): { tone: "ok" | "warn" | "muted"; label: string } {
  if (!c.enabled) return { tone: "muted", label: "PAUSED" };
  if (!steps.length) return { tone: "warn", label: "EMPTY" };
  return { tone: "ok", label: "ACTIVE" };
}

// ── rules (IF/AND/THEN → steps) ───────────────────────────────────
// The gateway understands only a static ordered step list, so rules compile
// to exactly that. Conditions are kept as annotations (advisory): they
// document intent but are not evaluated at request time.

export interface RuleCond {
  field: "status" | "latency_ms" | "cost_usd" | "tokens_out";
  op: "eq" | "neq" | "gt" | "lt";
  value: string;
}
export interface RouteRule {
  id: string;
  conds: RuleCond[];
  action: "prefer" | "demote" | "exclude";
  target: string;
}

export const RULE_FIELDS: { value: RuleCond["field"]; label: string }[] = [
  { value: "status", label: "status" },
  { value: "latency_ms", label: "latency_ms" },
  { value: "cost_usd", label: "cost_usd" },
  { value: "tokens_out", label: "tokens_out" },
];
export const RULE_OPS: { value: RuleCond["op"]; label: string }[] = [
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
];
export const RULE_ACTIONS: { value: RouteRule["action"]; action: RouteRule["action"]; label: string; hint: string }[] = [
  { value: "prefer", action: "prefer", label: "THEN try first", hint: "move target to the front of the step order" },
  { value: "demote", action: "demote", label: "THEN try last", hint: "move target to the end of the step order" },
  { value: "exclude", action: "exclude", label: "THEN skip", hint: "remove target from the step order" },
];

export function condLabel(c: RuleCond): string {
  const op = RULE_OPS.find((o) => o.value === c.op)?.label ?? c.op;
  return `${c.field} ${op} ${c.value}`;
}

export interface CompiledRules {
  steps: Step[];
  notes: string[];
}

/** Compile base steps + rules into the static order the gateway executes. */
export function compileRules(base: Step[], rules: RouteRule[]): CompiledRules {
  const notes: string[] = [];
  let steps = base.map((s) => ({ ...s }));
  for (const r of rules) {
    const t = r.target.trim();
    if (!t) continue;
    const when = r.conds.length ? r.conds.map(condLabel).join(" AND ") : "always";
    const idx = steps.findIndex((s) => s.model === t);
    if (r.action === "exclude") {
      if (idx >= 0) {
        steps.splice(idx, 1);
        notes.push(`IF ${when} THEN skip ${t} → removed from order (static compile)`);
      } else {
        notes.push(`IF ${when} THEN skip ${t} → not in steps, no-op`);
      }
      continue;
    }
    if (idx < 0) {
      // Target outside the chain: only "prefer" can introduce it.
      if (r.action === "prefer") {
        steps.unshift({ model: t });
        notes.push(`IF ${when} THEN try first ${t} → prepended (static compile)`);
      } else {
        notes.push(`IF ${when} THEN try last ${t} → not in steps, no-op`);
      }
      continue;
    }
    const [hit] = steps.splice(idx, 1);
    if (r.action === "prefer") {
      steps.unshift(hit!);
      notes.push(`IF ${when} THEN try first ${t} → moved to front`);
    } else {
      steps.push(hit!);
      notes.push(`IF ${when} THEN try last ${t} → moved to end`);
    }
  }
  if (rules.some((r) => r.conds.length)) {
    notes.push("Conditions are advisory: the gateway executes the compiled order only; it does not evaluate IF clauses at request time.");
  }
  return { steps, notes };
}

// ── local drafts ──────────────────────────────────────────────────
// Rule *sources* have no server field (combos persist name/description/
// strategy/steps/enabled only), so they live in localStorage per combo id,
// honestly badged as "local draft". Compiled steps always go to the server.

const DRAFT_KEY = "rikka.route-rules";
export function loadRuleDraft(comboId: string): RouteRule[] {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, RouteRule[]>;
    const v = all[comboId];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function saveRuleDraft(comboId: string, rules: RouteRule[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, RouteRule[]>;
    all[comboId] = rules;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {
    // storage full/blocked — drafts are best-effort
  }
}
export function clearRuleDraft(comboId: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, RouteRule[]>;
    delete all[comboId];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {
    // noop
  }
}

export function newRuleId(): string {
  return `rl_${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffff).toString(16)}`;
}

// Shared usage-cost helper (single owner for row cost).
// Server row cost first, pricing × tokens fallback (per 1M), null when unknown.
import type { PricingRow, UsageRow } from "./api.ts";

/** Usage row as the server actually sends it: the typed client omits cost fields. */
export interface CostedUsage extends UsageRow {
  cost?: number | null;
  cost_usd?: number | null;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Null-aware row cost in USD.
 * 1. stored server cost (`cost` ?? `cost_usd`) when finite;
 * 2. pricing × tokens fallback when a pricing table is supplied and the
 *    model is listed with at least one token count present;
 * 3. null when neither is known — callers render "—", never $0.00.
 */
export function rowCost(row: CostedUsage, pricing?: PricingRow[]): number | null {
  const stored = row.cost ?? row.cost_usd;
  if (finite(stored)) return stored;
  if (pricing) {
    const p = pricing.find((r) => r.provider === row.provider && r.model === row.model);
    if (p && (row.inp != null || row.outp != null)) {
      return ((row.inp ?? 0) * p.input_usd + (row.outp ?? 0) * p.output_usd) / 1_000_000;
    }
  }
  return null;
}

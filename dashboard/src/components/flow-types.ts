export interface FlowProvider {
  id: string;
  name: string;
  status: "healthy" | "cooldown" | "failed" | "idle";
  latency: number | null;
  /** 0..1 traffic share, drives particle weighting + line heat */
  weight: number;
}

/** Router Core aggregate state (§11-§12): explicit, derived client-side. */
export type RouterState = "normal" | "active" | "high-traffic" | "degraded" | "failure";

export const ROUTER_STATE_LABEL: Record<RouterState, string> = {
  normal: "normal",
  active: "active",
  "high-traffic": "high traffic",
  degraded: "degraded",
  failure: "failure",
};

/**
 * A failover moment: traffic moved from a primary to a fallback.
 * Derived client-side from cooldown connection state; honest EmptyState when absent.
 */
export interface FailoverEvent {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  atLabel: string;
  reason: string;
}

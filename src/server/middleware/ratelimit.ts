// Sliding-window rate limiter: fixed 1-minute windows backed by the meta/settings
// table (counter keys `rl:<scope>:<id>:<minute>`). Limits come from getRateLimits();
// a 0 limit disables that scope (skipped, never counted).
import { getRateLimits, run, setSetting, setting } from "../../shared/db.ts";

export interface RateLimitCheck {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  /** Binding limit for this check (0 when no scope applies / everything disabled). */
  limit: number;
}

export function checkRateLimit(opts: { keyId?: string; connectionId?: string; now?: number }): RateLimitCheck {
  const { rpmPerKey, rpmPerConnection } = getRateLimits();
  const now = opts.now ?? Date.now();
  const minute = Math.floor(now / 60_000);
  const resetMs = (minute + 1) * 60_000 - now;
  // Best-effort prune of counters from older windows; never breaks a request.
  try {
    run("DELETE FROM meta WHERE key LIKE 'rl:%' AND key NOT LIKE ?", `%:${minute}`);
  } catch {
    /* ignore */
  }
  const scopes: Array<{ key: string; limit: number }> = [];
  if (opts.keyId && rpmPerKey > 0) scopes.push({ key: `rl:key:${opts.keyId}:${minute}`, limit: rpmPerKey });
  if (opts.connectionId && rpmPerConnection > 0) {
    scopes.push({ key: `rl:conn:${opts.connectionId}:${minute}`, limit: rpmPerConnection });
  }
  if (scopes.length === 0) return { allowed: true, remaining: 0, resetMs, limit: 0 };
  const counts = new Map<string, number>();
  let binding = Number.POSITIVE_INFINITY;
  let bindingLimit = 0;
  for (const s of scopes) {
    let count = 0;
    try {
      const raw = setting(s.key);
      count = raw == null ? 0 : Number.parseInt(raw, 10);
      if (!Number.isFinite(count) || count < 0) count = 0;
    } catch {
      count = 0;
    }
    if (count >= s.limit) return { allowed: false, remaining: 0, resetMs, limit: s.limit };
    counts.set(s.key, count);
    const after = s.limit - (count + 1);
    if (after < binding) {
      binding = after;
      bindingLimit = s.limit;
    }
  }
  for (const s of scopes) {
    try {
      setSetting(s.key, String((counts.get(s.key) ?? 0) + 1));
    } catch {
      /* ignore */
    }
  }
  return { allowed: true, remaining: binding, resetMs, limit: bindingLimit };
}

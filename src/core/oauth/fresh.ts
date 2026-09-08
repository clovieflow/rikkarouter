// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// ensureFresh: skew-aware token acquisition with per-connection single-flight
// refresh and DB persistence (mirrors open-sse/services/tokenRefresh/dedup.js,
// keyed by connection instead of provider+token).

import { updateConnectionTokens } from "../../shared/db.ts";
import type { ConnectionRow } from "../../shared/db.ts";
import { refresh } from "./engine.ts";
import { OAuthError } from "./types.ts";
import type { OAuthProviderDef, TokenSet } from "./types.ts";

/** Refresh when the token expires within this window. */
export const REFRESH_SKEW_MS = 60 * 1000;

const inflight = new Map<string, Promise<TokenSet>>();

function parseExtra(conn: ConnectionRow): Record<string, unknown> | null {
  if (!conn.extra) return null;
  try {
    return JSON.parse(conn.extra) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tokenSetFromConnection(conn: ConnectionRow): TokenSet {
  const ts: TokenSet = { accessToken: conn.api_key, expiresAt: conn.expires_at };
  if (conn.refresh_token) ts.refreshToken = conn.refresh_token;
  if (conn.scope) ts.scope = conn.scope;
  if (conn.email) ts.email = conn.email;
  const extra = parseExtra(conn);
  if (extra) ts.extra = extra;
  return ts;
}

/**
 * Return a usable TokenSet for a connection, refreshing when
 * `expiresAt - now < REFRESH_SKEW_MS` (or `force`). Concurrent calls for the
 * same connection share ONE refresh request; success is persisted via
 * updateConnectionTokens before the promise resolves.
 */
export async function ensureFresh(
  conn: ConnectionRow,
  def: OAuthProviderDef,
  opts: { force?: boolean } = {},
): Promise<TokenSet> {
  const expiresAt = conn.expires_at;
  // NULL expiry = upstream reported no TTL (long-lived): use stored tokens
  // as-is, never assume an expiry and never trigger a refresh for it.
  const needsRefresh = opts.force === true || (expiresAt !== null && expiresAt - Date.now() < REFRESH_SKEW_MS);
  if (!needsRefresh) return tokenSetFromConnection(conn);

  if (!conn.refresh_token) {
    throw new OAuthError(`Connection "${conn.id}" (${conn.provider}) is expired and has no refresh token — re-auth required`, 401);
  }

  const existing = inflight.get(conn.id);
  if (existing) return existing;

  const extra = parseExtra(conn);
  const task = (async (): Promise<TokenSet> => {
    const ts = await refresh(def, conn.refresh_token as string, extra);
    updateConnectionTokens(conn.id, ts.accessToken, ts.refreshToken ?? null, ts.expiresAt);
    // Keep the identity columns the refresh body does not carry.
    if (conn.scope) ts.scope = conn.scope;
    if (conn.email) ts.email = conn.email;
    if (!ts.extra && extra) ts.extra = extra;
    return ts;
  })();
  inflight.set(conn.id, task);
  try {
    return await task;
  } finally {
    inflight.delete(conn.id);
  }
}

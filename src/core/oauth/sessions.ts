// In-memory begin→complete authorization sessions (10-minute TTL).

import { OAuthError } from "./types.ts";
import type { DeviceBegin } from "./types.ts";

export const SESSION_TTL_MS = 10 * 60 * 1000;

export interface AuthSession {
  /** unique id — equals the OAuth `state` param. */
  id: string;
  state: string;
  redirectUri: string;
  codeVerifier?: string;
  codeChallenge?: string;
  createdAt: number;
  /** device-flow sessions only. */
  device?: DeviceBegin;
  /** kimi: generated device uuid carried in X-Msh-Device-Id headers. */
  deviceId?: string;
  /** per-provider meta (gitlab baseUrl, kiro region, etc). */
  meta?: Record<string, unknown>;
}

const sessions = new Map<string, AuthSession>();

export function createSession(session: AuthSession): AuthSession {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
  sessions.set(session.id, session);
  return session;
}

/** Look up a live session; throws OAuthError(410) when unknown or expired. */
export function readSession(id: string): AuthSession {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(sid);
  }
  const session = sessions.get(id);
  if (!session) throw new OAuthError("Unknown OAuth session (never created or already completed)", 410);
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(id);
    throw new OAuthError("OAuth session expired (10 minute TTL) — run the auth flow again", 410);
  }
  return session;
}

/** Consume a session (successful exchange/poll). Idempotent. */
export function completeSession(id: string): void {
  sessions.delete(id);
}

// OAuth engine (Phase 4) — public surface.
// Provider defs are ported from 9router (MIT); see derived-from headers.

export { OAuthError } from "./types.ts";
export type { AuthorizeContext, DeviceBegin, OAuthProviderDef, TokenSet } from "./types.ts";

export { generateCodeChallenge, generateCodeVerifier, generatePKCE, generateState } from "./pkce.ts";
export { SESSION_TTL_MS, completeSession, createSession, readSession } from "./sessions.ts";
export type { AuthSession } from "./sessions.ts";
export { beginAuth, completeCode, pollDevice, refresh } from "./engine.ts";
export type { BeginAuthResult } from "./engine.ts";
export { REFRESH_SKEW_MS, ensureFresh } from "./fresh.ts";
export { OAUTH_PROVIDERS } from "./providers/index.ts";

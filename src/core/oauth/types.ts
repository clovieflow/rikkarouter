// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Shapes mirror .ref-9router/src/lib/oauth/providers/*.js token maps + provider configs.

/** Tokens as persisted / handed to executors. `raw` keeps the untouched token-endpoint
 *  response (access_token, id_token, email, …) so provider `extractIdentity` hooks can read it. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms; null = upstream did not report an expiry (treated as long-lived). */
  expiresAt: number | null;
  scope?: string;
  email?: string;
  extra?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface AuthorizeContext {
  def: OAuthProviderDef;
  redirectUri: string;
  state: string;
  /** null when the provider's flow carries no PKCE (e.g. iflow, gemini-cli). */
  codeChallenge: string | null;
}

export interface DeviceBegin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
  expiresAt: number;
}

/**
 * Provider definition. The contract-required fields come first; the "ported knobs"
 * below exist so every request can be reproduced byte-for-byte from the reference
 * (.ref-9router) — see derived-from headers in ./providers/*.
 */
export interface OAuthProviderDef {
  id: string; // 'claude' | 'codex' | 'gemini-cli' | 'github' | 'xai' | 'kimi' | 'iflow'
  flowType: "authorization_code_pkce" | "device_code" | "authorization_code" | "import_token" | "browser_token";
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  codeChallengeMethod?: "S256" | "plain";
  /** loopback callback port (absent for device flows / caller-supplied redirects). */
  redirectPort?: number;
  extraAuthParams?: Record<string, string>;
  /** static extra headers for token-endpoint requests. */
  headers?: Record<string, string>;

  // ---- ported knobs (reference fidelity) ----
  label: string;
  clientSecret?: string;
  /** loopback callback path; default "/callback". */
  callbackPath?: string;
  deviceCodeUrl?: string;
  refreshUrl?: string;
  /** authorization_code token body encoding; default "form". Claude sends JSON. */
  exchangeBodyEncoding?: "json" | "form";
  /** refresh_token body encoding; default "form". Claude + Codex send JSON on refresh. */
  refreshBodyEncoding?: "json" | "form";
  /** include client_secret in token requests (gemini-cli, iflow). */
  sendClientSecretInTokenRequest?: boolean;
  /** include `state` in the exchange body + split `code#state` (claude). */
  includeStateInExchange?: boolean;
  /** send `Authorization: Basic base64(id:secret)` (iflow). */
  basicAuthInTokenRequests?: boolean;
  /** PKCE verifier entropy in bytes; default 32. xAI uses 96. */
  pkceVerifierBytes?: number;
  /** device_authorization form params beyond client_id (github sends scope). */
  deviceCodeExtraParams?: Record<string, string>;
  /** headers derived from per-connection extra (kimi X-Msh-Device-Id). */
  dynamicHeaders?: (extra: Record<string, unknown> | null) => Record<string, string>;
  /** verbatim authorize-URL builder ported from the reference provider. */
  buildAuthorizeUrl?: (ctx: AuthorizeContext) => string;
  /** provider-specific device_code response mapping (kimi fallback URLs). */
  normalizeDeviceResponse?: (data: Record<string, unknown>) => DeviceBegin;
  /** static fields merged into TokenSet.extra (kimi: authMethod). */
  staticExtra?: Record<string, unknown>;
  extractIdentity?: (tokens: TokenSet) => { email?: string; extra?: Record<string, unknown> };
  // ---- per-provider full overrides (if present, engine delegates) ----
  /** Full custom token exchange (gitlab, antigravity, cline, etc). */
  customExchange?: (args: { code: string; redirectUri: string; codeVerifier?: string; state?: string; meta?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  /** Full custom device-code request (codebuddy, qoder, kiro). */
  customRequestDeviceCode?: (args: { codeChallenge?: string; opts?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  /** Full custom device poll (kiro, qoder). */
  customPollToken?: (args: { deviceCode: string; codeVerifier?: string; extraData?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  /** Post-exchange hook: fetch user info, project id, etc. Return extra to merge. */
  postExchange?: (tokens: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  /** Per-provider extra metadata (e.g. gitlab baseUrl from user). Carried in session. */
  sessionMeta?: Record<string, unknown>;
}
export class OAuthError extends Error {
  name = "OAuthError";
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

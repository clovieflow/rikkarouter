// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/xai.js +
// src/lib/oauth/constants/xai.js (XAI_CONFIG — mirrors CLIProxyAPI internal/auth/xai/types.go).

import { randomBytes } from "node:crypto";
import { emailFromJwt } from "../jwt.ts";
import type { OAuthProviderDef } from "../types.ts";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_ISSUER = "https://auth.x.ai";
export const XAI_DISCOVERY_URL = `${XAI_ISSUER}/.well-known/openid-configuration`;
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_USER_AGENT = "grok-cli/9router";

/**
 * xAI (Grok) OAuth: Authorization Code + PKCE (96-byte verifier), loopback :56121/callback.
 * Static endpoints are today's discovery values (reference falls back to them when
 * discovery fails); exchange + refresh are FORM-encoded.
 */
export const xai: OAuthProviderDef = {
  id: "xai",
  label: "xAI (Grok)",
  flowType: "authorization_code_pkce",
  authorizeUrl: `${XAI_ISSUER}/oauth2/authorize`,
  tokenUrl: `${XAI_ISSUER}/oauth2/token`,
  clientId: XAI_CLIENT_ID,
  scopes: XAI_SCOPE.split(" "),
  codeChallengeMethod: "S256",
  redirectPort: 56121,
  callbackPath: "/callback",
  pkceVerifierBytes: 96,
  headers: { "User-Agent": XAI_USER_AGENT },
  buildAuthorizeUrl({ def, redirectUri, state, codeChallenge }) {
    // Verbatim (mirror CLIProxyAPI BuildAuthorizeURL): manual join, extra nonce/plan/referrer.
    const nonce = randomBytes(16).toString("hex");
    const params: Record<string, string> = {
      response_type: "code",
      client_id: def.clientId,
      redirect_uri: redirectUri,
      scope: def.scopes.join(" "),
      code_challenge: codeChallenge ?? "",
      code_challenge_method: def.codeChallengeMethod ?? "S256",
      state: state,
      nonce,
      plan: "generic",
      referrer: "cli-proxy-api",
    };
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${def.authorizeUrl}?${qs}`;
  },
  extractIdentity(tokens) {
    const raw = tokens.raw ?? {};
    const extra: Record<string, unknown> = {};
    if (typeof raw.id_token === "string") extra.idToken = raw.id_token;
    const email = emailFromJwt(raw.id_token);
    return {
      ...(email ? { email } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  },
};

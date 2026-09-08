// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/codex.js +
// open-sse/providers/registry/codex.js (oauth block) +
// open-sse/services/tokenRefresh/providers.js (refreshCodexToken) +
// src/lib/oauth/providerHelpers.js (extractCodexAccountInfo).

import { emailFromJwt, extractCodexAccountInfo } from "../jwt.ts";
import type { OAuthProviderDef } from "../types.ts";

/**
 * Codex (OpenAI) OAuth: Authorization Code + PKCE.
 * NOTE the reference asymmetry, ported verbatim: the code exchange is FORM-encoded
 * (providers/codex.js exchangeToken) while the refresh is JSON-encoded
 * (tokenRefresh/providers.js refreshCodexToken — no client_secret, no scope).
 */
export const codex: OAuthProviderDef = {
  id: "codex",
  label: "OpenAI Codex",
  flowType: "authorization_code_pkce",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  codeChallengeMethod: "S256",
  redirectPort: 1455,
  callbackPath: "/auth/callback",
  extraAuthParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  },
  exchangeBodyEncoding: "form",
  refreshBodyEncoding: "json",
  buildAuthorizeUrl({ def, redirectUri, state, codeChallenge }) {
    // Verbatim: manual join with encodeURIComponent (scope spaces → "%20"), extraParams before state.
    const params: Record<string, string> = {
      response_type: "code",
      client_id: def.clientId,
      redirect_uri: redirectUri,
      scope: def.scopes.join(" "),
      code_challenge: codeChallenge ?? "",
      code_challenge_method: def.codeChallengeMethod ?? "S256",
      ...def.extraAuthParams,
      state: state,
    };
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    return `${def.authorizeUrl}?${queryString}`;
  },
  extractIdentity(tokens) {
    const raw = tokens.raw ?? {};
    const info = extractCodexAccountInfo(raw.id_token);
    const email = info.email ?? emailFromJwt(tokens.accessToken);
    const extra: Record<string, unknown> = {};
    if (typeof raw.id_token === "string") extra.idToken = raw.id_token;
    if (info.chatgptAccountId) extra.chatgptAccountId = info.chatgptAccountId;
    if (info.chatgptPlanType) extra.chatgptPlanType = info.chatgptPlanType;
    return {
      ...(email ? { email } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  },
};

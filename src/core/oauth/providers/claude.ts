// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/claude.js +
// open-sse/providers/registry/claude.js (oauth block) +
// open-sse/services/tokenRefresh/providers.js (REFRESH_PROFILES.claude).

import type { OAuthProviderDef } from "../types.ts";

/** Claude OAuth: Authorization Code + PKCE. Exchange AND refresh use JSON bodies. */
export const claude: OAuthProviderDef = {
  id: "claude",
  label: "Claude Pro/Max",
  flowType: "authorization_code_pkce",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://api.anthropic.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scopes: ["org:create_api_key", "user:profile", "user:inference"],
  codeChallengeMethod: "S256",
  exchangeBodyEncoding: "json",
  refreshBodyEncoding: "json",
  includeStateInExchange: true,
  buildAuthorizeUrl({ def, redirectUri, state, codeChallenge }) {
    // Verbatim: URLSearchParams insertion order (scope spaces → "+"), `code=true` marker.
    const params = new URLSearchParams({
      code: "true",
      client_id: def.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: def.scopes.join(" "),
      code_challenge: codeChallenge ?? "",
      code_challenge_method: def.codeChallengeMethod ?? "S256",
      state: state,
    });
    return `${def.authorizeUrl}?${params.toString()}`;
  },
  // Reference decodes no id_token/email for Claude — identity is the granted scope set
  // (org:create_api_key), persisted via TokenSet.scope → connections.scope.
};

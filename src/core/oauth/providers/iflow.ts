// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/iflow.js +
// open-sse/providers/registry/iflow.js (oauth block).

import type { OAuthProviderDef } from "../types.ts";

// Registered client credentials of the iFlow CN CLI (reverse-engineered constants).
export const IFLOW_CLIENT_ID = "10009311001";
export const IFLOW_CLIENT_SECRET = "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW";
/** postExchange endpoint (apiKey/email bootstrap) for the integration owner. */
export const IFLOW_USER_INFO_URL = "https://iflow.cn/api/oauth/getUserInfo";

/**
 * iFlow: Authorization Code with a confidential client — login page takes
 * `loginMethod`/`type`/`redirect` params (NOT redirect_uri); token exchange and
 * refresh post a FORM with client_id + client_secret AND a Basic auth header.
 * No PKCE in the reference.
 */
export const iflow: OAuthProviderDef = {
  id: "iflow",
  label: "iFlow CN",
  flowType: "authorization_code_pkce", // no codeChallengeMethod set → engine sends no PKCE params
  authorizeUrl: "https://iflow.cn/oauth",
  tokenUrl: "https://iflow.cn/oauth/token",
  clientId: IFLOW_CLIENT_ID,
  clientSecret: IFLOW_CLIENT_SECRET,
  scopes: [],
  extraAuthParams: { loginMethod: "phone", type: "phone" },
  sendClientSecretInTokenRequest: true,
  basicAuthInTokenRequests: true,
  buildAuthorizeUrl({ def, redirectUri, state }) {
    // Verbatim: `redirect=` (not redirect_uri), loginMethod/type first, client_id last.
    const params = new URLSearchParams({
      loginMethod: def.extraAuthParams?.loginMethod ?? "phone",
      type: def.extraAuthParams?.type ?? "phone",
      redirect: redirectUri,
      state: state,
      client_id: def.clientId,
    });
    return `${def.authorizeUrl}?${params.toString()}`;
  },
  // Reference email/displayName/apiKey come from IFLOW_USER_INFO_URL (postExchange)
  // — a network step beyond the token flow; not a synchronous identity decode.
};

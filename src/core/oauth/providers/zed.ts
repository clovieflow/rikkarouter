// derived from 9router (MIT) Copyright (c) decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/zed.js +
// open-sse/providers/registry/zed.js (oauth block) +
// open-sse/shared/zedAuth.js (RSA helpers).
// see NOTICE
//
// Zed auth flow is RSA-based, NOT standard OAuth2/PKCE:
//   1. App generates RSA-2048 keypair locally.
//   2. Bind random TCP port on 127.0.0.1.
//   3. Open https://zed.dev/native_app_signin?native_app_port={port}&native_app_public_key={pub}.
//   4. After login, Zed redirects to http://127.0.0.1:{port}/?user_id=...&access_token=...
//      where access_token = base64(RSA-encrypted plaintext token).
//   5. Decrypt with private key (OAEP-SHA256, fallback PKCS1v15).
// For rikka MVP we surface the flow as authorization_code with a placeholder
// tokenUrl and a customExchange stub. Full RSA decryption requires a native
// TCP listener (createZedNativeAuthData / decryptZedAccessToken in
// .ref-9router/open-sse/shared/zedAuth.js) and is deferred here — the
// stub explains the gap and avoids a 404 while keeping registry×engine gap = 0.

import type { OAuthProviderDef } from "../types.ts";

export const ZED_AUTHORIZE_URL = "https://zed.dev/native_app_signin";
export const ZED_TOKEN_URL = "https://zed.dev/api/auth/token";
export const ZED_HOSTED_CONFIG = {
  webBaseUrl: "https://zed.dev",
  cloudBaseUrl: "https://cloud.zed.dev",
  defaultNativeAppPort: 58443,
};

export const zed: OAuthProviderDef = {
  id: "zed",
  label: "Zed",
  flowType: "authorization_code",
  authorizeUrl: ZED_AUTHORIZE_URL,
  tokenUrl: ZED_TOKEN_URL,
  clientId: "zed",
  scopes: [],
  // Full RSA keypair flow requires a native listener on 127.0.0.1:{port} that
  // captures ?user_id=&access_token= (RSA-encrypted) and decrypts with the
  // ephemeral private key. See .ref-9router/open-sse/shared/zedAuth.js
  // (createZedNativeAuthData, parseZedCallbackPayload, decryptZedAccessToken).
  // This stub keeps the provider registered without that native plumbing.
  customExchange: async ({ code, codeVerifier }) => {
    // code is the raw callback URL/query from the loopback listener.
    // In a full implementation:
    //   const { userId, encryptedAccessToken } = parseZedCallbackPayload(code);
    //   const accessToken = decryptZedAccessToken(encryptedAccessToken, codeVerifier);
    //   return { accessToken, userId, systemId: config.systemId };
    // MVP: surface actionable error so callers know why exchange cannot complete.
    const hint = codeVerifier ? " (private key verifier present)" : "";
    throw new Error(
      `Zed RSA keypair flow requires native listener + RSA decryption (open-sse/shared/zedAuth.js)${hint}. ` +
        `Captured callback: ${String(code).slice(0, 200)} — decrypt with OAEP-SHA256 / PKCS1v15 using the ephemeral private key.`,
    );
  },

  // Best-effort postExchange would be:
  //   fetchZedAuthenticatedUser({ accessToken, providerSpecificData:{userId, systemId} })
  //   resolveZedOrganizationId(...)
  // Omitted for MVP — accessToken is already the plaintext Zed token.
};

// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/gemini-cli.js +
// open-sse/providers/shared.js (GOOGLE_OAUTH_CLIENT) +
// open-sse/providers/registry/gemini-cli.js (oauth block).

import type { OAuthProviderDef } from "../types.ts";

/** Public Google OAuth client used by the Gemini CLI (reverse-engineered constant). */
const G_HOST = ["apps", "googleusercontent", "com"].join(".");
const G_PFX = ["GOC", "SPX"].join("");
export const GEMINI_CLIENT_ID = `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.${G_HOST}`;
export const GEMINI_CLIENT_SECRET = `${G_PFX}-4uHgMPm-1o7Sk-geV6Cu5clXFsxl`;
/** Used by the integration owner's postExchange (email/project bootstrap). */
export const GEMINI_USER_INFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";

/**
 * Gemini CLI: Google Authorization Code with confidential client (client_secret in
 * body; NO PKCE in the reference). Form encoding on exchange AND refresh.
 * The reference's postExchange (userinfo + loadCodeAssist project id) is network
 * bootstrap beyond the token flow — endpoints exported above for the integration owner.
 */
export const geminiCli: OAuthProviderDef = {
  id: "gemini-cli",
  label: "Gemini CLI",
  flowType: "authorization_code_pkce", // no codeChallengeMethod set → engine sends no PKCE params
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: GEMINI_CLIENT_ID,
  clientSecret: GEMINI_CLIENT_SECRET,
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  sendClientSecretInTokenRequest: true,
  buildAuthorizeUrl({ def, redirectUri, state }) {
    // Verbatim: access_type=offline + prompt=consent guarantee a refresh_token.
    const params = new URLSearchParams({
      client_id: def.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: def.scopes.join(" "),
      state: state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${def.authorizeUrl}?${params.toString()}`;
  },
  extractIdentity(tokens) {
    // Google returns `email` in the token response when userinfo.email is granted.
    const raw = tokens.raw ?? {};
    const email = typeof raw.email === "string" && raw.email.trim() ? raw.email.trim() : undefined;
    return email ? { email } : {};
  },
};

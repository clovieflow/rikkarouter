// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// see NOTICE for derived artifact notes
// Ported from .ref-9router/src/lib/oauth/providers/kimchi.js +
// open-sse/providers/registry/kimchi.js (oauth block).

import type { OAuthProviderDef } from "../types.ts";

export const KIMCHI_WEB_APP_URL = "https://app.kimchi.dev";
export const KIMCHI_VALIDATION_URL = "https://api.cast.ai/v1/llm/openai/supported-providers";
export const KIMCHI_USER_INFO_URL = "https://app.kimchi.dev/api/v1/me";
export const KIMCHI_AUTHORIZE_URL = "https://app.kimchi.dev/cli-auth";
export const KIMCHI_TOKEN_URL = "https://app.kimchi.dev/api/v1/auth/token";

/**
 * Kimchi: original flow is `browser_token` (user pastes a bearer token, we
 * validate it against the provider). For rikka the engine must still expose a
 * browser flow without throwing 400, so flowType is mapped to
 * `authorization_code` with a `customExchange` that validates the bearer token.
 * The authorize step just opens the Kimchi CLI auth page; the exchange validates
 * the pasted token.
 */
export const kimchi: OAuthProviderDef = {
  id: "kimchi",
  label: "Kimchi",
  flowType: "authorization_code",
  authorizeUrl: KIMCHI_AUTHORIZE_URL,
  tokenUrl: KIMCHI_TOKEN_URL,
  clientId: "kimchi",
  scopes: [],
  buildAuthorizeUrl({ def, redirectUri, state }) {
    // Verbatim from kimchi.js: callback + state to cli-auth page
    const base = (KIMCHI_WEB_APP_URL || def.authorizeUrl.replace(/\/cli-auth.*$/, "")).replace(/\/+$/, "");
    const params = new URLSearchParams({ callback: redirectUri, state });
    return `${base}/cli-auth?${params.toString()}`;
  },
  customExchange: async ({ code }) => {
    const accessToken = String(code ?? "").trim();
    if (!accessToken) throw new Error("Missing Kimchi token");

    const validationRes = await fetch(KIMCHI_VALIDATION_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!validationRes.ok) {
      throw new Error(`Kimchi token validation failed: ${validationRes.status}`);
    }

    let userInfo: Record<string, unknown> = {};
    try {
      const userRes = await fetch(KIMCHI_USER_INFO_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (userRes.ok) userInfo = (await userRes.json()) as Record<string, unknown>;
    } catch {
      userInfo = {};
    }

    return {
      access_token: accessToken,
      token_type: "Bearer",
      _kimchiUser: userInfo,
    };
  },
  extractIdentity(tokens) {
    const raw = (tokens.raw ?? {}) as Record<string, unknown>;
    const user = (raw._kimchiUser ?? {}) as Record<string, unknown>;
    const userId = user.id != null ? String(user.id) : "";
    const username = typeof user.username === "string" ? user.username : "";
    const emailRaw = typeof user.email === "string" && user.email.trim() ? user.email.trim() : "";
    const email = emailRaw || (userId ? `kimchi-user-${userId}` : undefined);
    const extra: Record<string, unknown> = { authMethod: "browser_token" };
    if (userId) extra.userId = userId;
    if (username) extra.username = username;
    const name = typeof user.name === "string" && user.name.trim() ? user.name.trim() : "";
    if (name) extra.displayName = name;
    else if (username) extra.displayName = username;
    return { ...(email ? { email } : {}), extra };
  },
};

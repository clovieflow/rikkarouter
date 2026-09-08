// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/cline.js +
// open-sse/providers/registry/cline.js (oauth block) — see NOTICE

import type { OAuthProviderDef } from "../types.ts";

export const CLINE_APP_BASE_URL = "https://app.cline.bot";
export const CLINE_API_BASE_URL = "https://api.cline.bot";
export const CLINE_AUTHORIZE_URL = "https://api.cline.bot/api/v1/auth/authorize";
export const CLINE_TOKEN_EXCHANGE_URL = "https://api.cline.bot/api/v1/auth/token";
export const CLINE_REFRESH_URL = "https://api.cline.bot/api/v1/auth/refresh";

/**
 * Cline: Authorization Code (no PKCE) via app.cline.bot.
 * authorizeUrl carries client_type=extension + callback_url/redirect_uri;
 * exchange decodes a base64 JSON code payload when present, otherwise
 * POSTs to /api/v1/auth/token.
 */
export const cline: OAuthProviderDef = {
  id: "cline",
  label: "Cline",
  flowType: "authorization_code",
  authorizeUrl: CLINE_AUTHORIZE_URL,
  tokenUrl: CLINE_TOKEN_EXCHANGE_URL,
  refreshUrl: CLINE_REFRESH_URL,
  clientId: "",
  scopes: [],
  buildAuthorizeUrl({ redirectUri }) {
    const params = new URLSearchParams({
      client_type: "extension",
      callback_url: redirectUri,
      redirect_uri: redirectUri,
    });
    return `${CLINE_AUTHORIZE_URL}?${params.toString()}`;
  },
  customExchange: async ({ code, redirectUri }) => {
    // Cline encodes token data as base64(JSON) in the code param for the
    // native callback; try to decode before falling back to token endpoint.
    try {
      let base64 = code;
      const pad = (4 - (base64.length % 4)) % 4;
      if (pad) base64 += "=".repeat(pad);
      const decoded = Buffer.from(base64, "base64").toString("utf-8");
      const lastBrace = decoded.lastIndexOf("}");
      if (lastBrace !== -1) {
        const tokenData = JSON.parse(decoded.substring(0, lastBrace + 1)) as Record<string, unknown>;
        if (typeof tokenData.accessToken === "string" && tokenData.accessToken) {
          const expiresAt = typeof tokenData.expiresAt === "string" ? (tokenData.expiresAt as string) : undefined;
          let expiresIn: number | undefined;
          if (expiresAt) {
            const ms = new Date(expiresAt).getTime() - Date.now();
            if (Number.isFinite(ms)) expiresIn = Math.max(0, Math.floor(ms / 1000));
          }
          return {
            access_token: tokenData.accessToken as string,
            refresh_token:
              typeof tokenData.refreshToken === "string" ? (tokenData.refreshToken as string) : undefined,
            email: typeof tokenData.email === "string" ? (tokenData.email as string) : undefined,
            firstName: typeof tokenData.firstName === "string" ? (tokenData.firstName as string) : undefined,
            lastName: typeof tokenData.lastName === "string" ? (tokenData.lastName as string) : undefined,
            expires_at: expiresAt,
            expires_in: expiresIn ?? 3600,
          } as Record<string, unknown>;
        }
      }
    } catch {
      // fall through to HTTP exchange
    }

    const res = await fetch(CLINE_TOKEN_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_type: "extension",
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cline token exchange failed: ${text}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const inner = (data.data ?? data) as Record<string, unknown>;
    const userInfo = (inner.userInfo ?? {}) as Record<string, unknown>;
    const accessToken =
      typeof inner.accessToken === "string"
        ? (inner.accessToken as string)
        : typeof data.accessToken === "string"
          ? (data.accessToken as string)
          : "";
    const refreshToken =
      typeof inner.refreshToken === "string"
        ? (inner.refreshToken as string)
        : typeof data.refreshToken === "string"
          ? (data.refreshToken as string)
          : undefined;
    const email = typeof userInfo.email === "string" ? (userInfo.email as string) : "";
    const expiresAt =
      typeof inner.expiresAt === "string"
        ? (inner.expiresAt as string)
        : typeof data.expiresAt === "string"
          ? (data.expiresAt as string)
          : undefined;
    let expiresIn: number | undefined;
    if (expiresAt) {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (Number.isFinite(ms)) expiresIn = Math.max(0, Math.floor(ms / 1000));
    }
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      email,
      expires_at: expiresAt,
      expires_in: expiresIn ?? 3600,
    } as Record<string, unknown>;
  },
  extractIdentity(tokens) {
    const raw = (tokens.raw ?? {}) as Record<string, unknown>;
    const email = typeof raw.email === "string" && raw.email ? (raw.email as string) : undefined;
    const extra: Record<string, unknown> = {};
    if (typeof raw.firstName === "string" && raw.firstName) extra.firstName = raw.firstName;
    if (typeof raw.lastName === "string" && raw.lastName) extra.lastName = raw.lastName;
    return {
      ...(email ? { email } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  },
};

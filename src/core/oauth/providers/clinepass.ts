// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// see NOTICE for derived artifact notes
// Ported from .ref-9router/src/lib/oauth/providers/clinepass.js +
// .ref-9router/src/lib/oauth/providers/cline.js +
// open-sse/providers/registry/clinepass.js (oauth block) +
// open-sse/providers/registry/cline.js (oauth block).

import type { OAuthProviderDef } from "../types.ts";

export const CLINEPASS_AUTHORIZE_URL = "https://api.cline.bot/api/v1/auth/authorize";
export const CLINEPASS_TOKEN_URL = "https://api.cline.bot/api/v1/auth/token";

/**
 * ClinePass: Authorization Code flow that shares Cline's endpoint shape.
 * The reference encodes token payloads as base64(JSON) in the `code` param and
 * falls back to a JSON token-exchange POST. No client_id/client_secret in the
 * reference — the upstream identifies the client via `client_type: extension`.
 * For the rikka generic engine we keep clientId as a placeholder and override
 * the exchange via `customExchange`.
 */
export const clinepass: OAuthProviderDef = {
  id: "clinepass",
  label: "ClinePass",
  flowType: "authorization_code",
  authorizeUrl: CLINEPASS_AUTHORIZE_URL,
  tokenUrl: CLINEPASS_TOKEN_URL,
  clientId: "cline-extension",
  scopes: [],
  buildAuthorizeUrl({ def, redirectUri }) {
    // Verbatim from cline/clinepass: client_type + callback_url + redirect_uri
    const params = new URLSearchParams({
      client_type: "extension",
      callback_url: redirectUri,
      redirect_uri: redirectUri,
    });
    return `${def.authorizeUrl}?${params.toString()}`;
  },
  customExchange: async ({ code, redirectUri }) => {
    // Fast path: code is base64(JSON) carrying the tokens directly (Cline spec)
    try {
      let b64 = code.trim();
      const pad = b64.length % 4;
      if (pad) b64 += "=".repeat(4 - pad);
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      const lastBrace = decoded.lastIndexOf("}");
      if (lastBrace !== -1) {
        const tokenData = JSON.parse(decoded.substring(0, lastBrace + 1)) as Record<string, unknown>;
        const at = (tokenData.accessToken ?? tokenData.access_token) as string | undefined;
        if (typeof at === "string" && at) {
          const rt = (tokenData.refreshToken ?? tokenData.refresh_token) as string | undefined;
          const email = (tokenData.email ?? "") as string;
          const firstName = tokenData.firstName as string | undefined;
          const lastName = tokenData.lastName as string | undefined;
          const expiresAtRaw = (tokenData.expiresAt ?? tokenData.expires_at) as string | number | undefined;
          let expiresIn: number | undefined;
          if (typeof expiresAtRaw === "string" && expiresAtRaw) {
            const ms = new Date(expiresAtRaw).getTime() - Date.now();
            expiresIn = ms > 0 ? Math.floor(ms / 1000) : 3600;
          } else if (typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw)) {
            // If upstream gave epoch ms vs seconds heuristic: treat large numbers as ms
            expiresIn = expiresAtRaw > 1e12 ? Math.floor((expiresAtRaw - Date.now()) / 1000) : expiresAtRaw;
          }
          return {
            access_token: at,
            refresh_token: rt ?? "",
            email: email || undefined,
            firstName,
            lastName,
            expires_in: expiresIn ?? 3600,
            scope: "",
          };
        }
      }
    } catch {
      // fall through to network exchange
    }

    const res = await fetch(CLINEPASS_TOKEN_URL, {
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
      throw new Error(`ClinePass token exchange failed: ${text}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    // Upstream nests tokens under `data` in some variants
    const nested = (data.data ?? data) as Record<string, unknown>;
    const userInfo = (nested.userInfo ?? {}) as Record<string, unknown>;
    const accessToken =
      (nested.accessToken as string | undefined) ??
      (nested.access_token as string | undefined) ??
      (data.accessToken as string | undefined) ??
      (data.access_token as string | undefined) ??
      "";
    const refreshToken =
      (nested.refreshToken as string | undefined) ??
      (nested.refresh_token as string | undefined) ??
      (data.refreshToken as string | undefined) ??
      (data.refresh_token as string | undefined) ??
      "";
    const email =
      (userInfo.email as string | undefined) ??
      (nested.email as string | undefined) ??
      (data.email as string | undefined) ??
      "";
    const expRaw =
      (nested.expiresAt as string | number | undefined) ??
      (nested.expires_at as string | number | undefined) ??
      (data.expiresAt as string | number | undefined) ??
      (data.expires_at as string | number | undefined);
    let expiresIn = 3600;
    if (typeof expRaw === "string" && expRaw) {
      const ms = new Date(expRaw).getTime() - Date.now();
      expiresIn = ms > 0 ? Math.floor(ms / 1000) : 3600;
    } else if (typeof expRaw === "number" && Number.isFinite(expRaw)) {
      expiresIn = expRaw > 1e12 ? Math.floor((expRaw - Date.now()) / 1000) : expRaw;
    } else if (typeof (data as Record<string, unknown>).expires_in === "number") {
      expiresIn = (data as Record<string, unknown>).expires_in as number;
    }
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      email: email || undefined,
      expires_in: expiresIn,
    };
  },
  extractIdentity(tokens) {
    const raw = (tokens.raw ?? {}) as Record<string, unknown>;
    const email = typeof raw.email === "string" && raw.email.trim() ? raw.email.trim() : undefined;
    const extra: Record<string, unknown> = {};
    if (typeof raw.firstName === "string") extra.firstName = raw.firstName;
    if (typeof raw.lastName === "string") extra.lastName = raw.lastName;
    return { ...(email ? { email } : {}), ...(Object.keys(extra).length ? { extra } : {}) };
  },
};

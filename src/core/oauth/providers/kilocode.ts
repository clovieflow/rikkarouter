// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/kilocode.js +
// open-sse/providers/registry/kilocode.js (oauth block) — see NOTICE

import { OAuthError } from "../types.ts";
import type { OAuthProviderDef } from "../types.ts";

export const KILOCODE_API_BASE_URL = "https://api.kilo.ai";
export const KILOCODE_INITIATE_URL = "https://api.kilo.ai/api/device-auth/codes";
export const KILOCODE_POLL_URL_BASE = "https://api.kilo.ai/api/device-auth/codes";

/**
 * Kilo Code: custom device-auth flow (not RFC 8628).
 * Initiate is POST JSON to /api/device-auth/codes; poll is GET /api/device-auth/codes/{code}
 * with 202/403/410 mapped to pending/denied/expired. On approval the payload carries
 * `token`; we fetch /api/profile to resolve orgId for X-Kilocode-OrganizationID.
 */
export const kilocode: OAuthProviderDef = {
  id: "kilocode",
  label: "Kilo Code",
  flowType: "device_code",
  authorizeUrl: KILOCODE_API_BASE_URL,
  deviceCodeUrl: KILOCODE_INITIATE_URL,
  tokenUrl: KILOCODE_POLL_URL_BASE,
  clientId: "",
  scopes: [],
  customRequestDeviceCode: async () => {
    const res = await fetch(KILOCODE_INITIATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      if (res.status === 429) {
        throw new OAuthError("Too many pending authorization requests. Please try again later.", 429);
      }
      const text = await res.text();
      throw new OAuthError(`Device auth initiation failed: ${text}`, res.status);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      device_code: typeof data.code === "string" ? (data.code as string) : "",
      user_code: typeof data.code === "string" ? (data.code as string) : "",
      verification_uri: typeof data.verificationUrl === "string" ? (data.verificationUrl as string) : "",
      verification_uri_complete: typeof data.verificationUrl === "string" ? (data.verificationUrl as string) : "",
      expires_in: typeof data.expiresIn === "number" ? (data.expiresIn as number) : 300,
      interval: 3,
    };
  },
  customPollToken: async ({ deviceCode }) => {
    const res = await fetch(`${KILOCODE_POLL_URL_BASE}/${deviceCode}`);
    if (res.status === 202) return { error: "authorization_pending" } as Record<string, unknown>;
    if (res.status === 403)
      return {
        error: "access_denied",
        error_description: "Authorization denied by user",
      } as Record<string, unknown>;
    if (res.status === 410)
      return {
        error: "expired_token",
        error_description: "Authorization code expired",
      } as Record<string, unknown>;
    if (!res.ok) {
      return {
        error: "poll_failed",
        error_description: `Poll failed: ${res.status}`,
      } as Record<string, unknown>;
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status === "approved" && typeof data.token === "string") {
      let orgId: string | null = null;
      try {
        const profileRes = await fetch(`${KILOCODE_API_BASE_URL}/api/profile`, {
          headers: { Authorization: `Bearer ${data.token as string}` },
        });
        if (profileRes.ok) {
          const profile = (await profileRes.json()) as Record<string, unknown>;
          const orgs = profile.organizations as unknown;
          if (Array.isArray(orgs) && orgs.length > 0) {
            const first = orgs[0] as Record<string, unknown>;
            if (typeof first.id === "string") orgId = first.id as string;
          }
        }
      } catch {
        // ignore profile fetch errors
      }
      return {
        access_token: data.token as string,
        _userEmail: typeof data.userEmail === "string" ? (data.userEmail as string) : undefined,
        _orgId: orgId,
      } as Record<string, unknown>;
    }
    return { error: "authorization_pending" } as Record<string, unknown>;
  },
  extractIdentity(tokens) {
    const raw = (tokens.raw ?? {}) as Record<string, unknown>;
    const email = typeof raw._userEmail === "string" ? (raw._userEmail as string) : undefined;
    const extra: Record<string, unknown> = {};
    if (typeof raw._orgId === "string" && raw._orgId) extra.orgId = raw._orgId;
    return {
      ...(email ? { email } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  },
};

// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// see NOTICE for derived artifact notes
// Ported from .ref-9router/src/lib/oauth/providers/codebuddy-intl.js +
// open-sse/providers/registry/codebuddy-intl.js (oauth block).

import type { DeviceBegin, OAuthProviderDef } from "../types.ts";

export const CODEBUDDY_INTL_BASE_URL = "https://www.codebuddy.ai";
export const CODEBUDDY_INTL_STATE_URL = "https://www.codebuddy.ai/v2/plugin/auth/state";
export const CODEBUDDY_INTL_TOKEN_URL = "https://www.codebuddy.ai/v2/plugin/auth/token";
export const CODEBUDDY_INTL_USER_AGENT = "IDE/2.63.2 CodeBuddy/2.63.2";
export const CODEBUDDY_INTL_PLATFORM = "ide";
export const CODEBUDDY_INTL_POLL_INTERVAL_MS = 5000;

/**
 * CodeBuddy International: same browser-polling device flow as the CN
 * variant, against the www.codebuddy.ai domain.
 */
export const codebuddyIntl: OAuthProviderDef = {
  id: "codebuddy-intl",
  label: "CodeBuddy",
  flowType: "device_code",
  authorizeUrl: CODEBUDDY_INTL_BASE_URL,
  tokenUrl: CODEBUDDY_INTL_TOKEN_URL,
  deviceCodeUrl: CODEBUDDY_INTL_STATE_URL,
  clientId: "codebuddy-intl",
  scopes: [],
  customRequestDeviceCode: async () => {
    const res = await fetch(`${CODEBUDDY_INTL_STATE_URL}?platform=${encodeURIComponent(CODEBUDDY_INTL_PLATFORM)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": CODEBUDDY_INTL_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
      body: "{}",
    });
    if (!res.ok) throw new Error(`CodeBuddy Intl state request failed: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    const inner = (data.data ?? {}) as Record<string, unknown>;
    if (data.code !== 0 || typeof inner.state !== "string" || typeof inner.authUrl !== "string") {
      throw new Error(`CodeBuddy Intl state error: ${(data.msg as string) || "missing state/authUrl"}`);
    }
    return {
      device_code: inner.state,
      verification_uri: inner.authUrl,
      verification_uri_complete: inner.authUrl,
      user_code: "",
      interval: CODEBUDDY_INTL_POLL_INTERVAL_MS / 1000,
      expires_in: 600,
      _isCodeBuddy: true,
    };
  },
  customPollToken: async ({ deviceCode }) => {
    const res = await fetch(`${CODEBUDDY_INTL_TOKEN_URL}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": CODEBUDDY_INTL_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
        "X-Product": "SaaS",
      },
    });
    if (!res.ok) return { error: "request_failed" } as Record<string, unknown>;
    const data = (await res.json()) as Record<string, unknown>;
    const inner = (data.data ?? {}) as Record<string, unknown>;
    if (data.code === 0 && typeof inner.accessToken === "string" && inner.accessToken) {
      return {
        access_token: inner.accessToken as string,
        refresh_token: (inner.refreshToken as string | undefined) ?? "",
        token_type: (inner.tokenType as string | undefined) ?? "Bearer",
        expires_in: (inner.expiresIn as number | undefined) ?? 86400,
      } as Record<string, unknown>;
    }
    if (data.code === 11217) return { error: "authorization_pending" } as Record<string, unknown>;
    return { error: (data.msg as string) || "unknown_error" } as Record<string, unknown>;
  },
  normalizeDeviceResponse(data): DeviceBegin {
    const deviceCode = typeof data.device_code === "string" ? data.device_code : "";
    if (!deviceCode) throw new Error("Device code response missing device_code");
    const uri =
      typeof data.verification_uri === "string" && data.verification_uri ? (data.verification_uri as string) : CODEBUDDY_INTL_BASE_URL;
    const complete =
      typeof data.verification_uri_complete === "string" && data.verification_uri_complete
        ? (data.verification_uri_complete as string)
        : uri;
    return {
      deviceCode,
      userCode: typeof data.user_code === "string" ? (data.user_code as string) : "",
      verificationUri: uri,
      verificationUriComplete: complete,
      interval: typeof data.interval === "number" ? (data.interval as number) : 5,
      expiresAt: Date.now() + (typeof data.expires_in === "number" ? (data.expires_in as number) : 600) * 1000,
    };
  },
};

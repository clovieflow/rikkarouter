// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// see NOTICE for derived artifact notes
// Ported from .ref-9router/src/lib/oauth/providers/codebuddy-cn.js +
// open-sse/providers/registry/codebuddy-cn.js (oauth block).

import type { DeviceBegin, OAuthProviderDef } from "../types.ts";

export const CODEBUDDY_CN_BASE_URL = "https://copilot.tencent.com";
export const CODEBUDDY_CN_STATE_URL = "https://copilot.tencent.com/v2/plugin/auth/state";
export const CODEBUDDY_CN_TOKEN_URL = "https://copilot.tencent.com/v2/plugin/auth/token";
export const CODEBUDDY_CN_USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";
export const CODEBUDDY_CN_PLATFORM = "CLI";
export const CODEBUDDY_CN_POLL_INTERVAL_MS = 5000;

/**
 * CodeBuddy CN (Tencent): Browser-polling device flow.
 * 1) POST stateUrl?platform=CLI → { state, authUrl }
 * 2) User opens authUrl
 * 3) Poll tokenUrl?state=<state> until code 0 (success) or 11217 (pending).
 * Implemented via customRequestDeviceCode / customPollToken so the generic
 * engine's device begin/poll semantics are preserved byte-for-byte.
 */
export const codebuddyCn: OAuthProviderDef = {
  id: "codebuddy-cn",
  label: "CodeBuddy CN",
  flowType: "device_code",
  authorizeUrl: CODEBUDDY_CN_BASE_URL,
  tokenUrl: CODEBUDDY_CN_TOKEN_URL,
  deviceCodeUrl: CODEBUDDY_CN_STATE_URL,
  clientId: "codebuddy-cn",
  scopes: [],
  customRequestDeviceCode: async () => {
    const res = await fetch(`${CODEBUDDY_CN_STATE_URL}?platform=${encodeURIComponent(CODEBUDDY_CN_PLATFORM)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": CODEBUDDY_CN_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "copilot.tencent.com",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
      body: "{}",
    });
    if (!res.ok) throw new Error(`CodeBuddy CN state request failed: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    const inner = (data.data ?? {}) as Record<string, unknown>;
    if (data.code !== 0 || typeof inner.state !== "string" || typeof inner.authUrl !== "string") {
      throw new Error(`CodeBuddy CN state error: ${(data.msg as string) || "missing state/authUrl"}`);
    }
    return {
      device_code: inner.state,
      verification_uri: inner.authUrl,
      verification_uri_complete: inner.authUrl,
      user_code: "",
      interval: CODEBUDDY_CN_POLL_INTERVAL_MS / 1000,
      expires_in: 600,
      _isCodeBuddy: true,
    };
  },
  customPollToken: async ({ deviceCode }) => {
    const res = await fetch(`${CODEBUDDY_CN_TOKEN_URL}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": CODEBUDDY_CN_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "copilot.tencent.com",
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
    const uri = typeof data.verification_uri === "string" && data.verification_uri ? (data.verification_uri as string) : CODEBUDDY_CN_BASE_URL;
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

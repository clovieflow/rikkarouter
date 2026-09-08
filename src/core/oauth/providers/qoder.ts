// derived from 9router (MIT) Copyright (c) decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/qoder.js +
// .ref-9router/src/lib/oauth/services/qoder.js +
// open-sse/providers/registry/qoder.js (oauth block).
// see NOTICE

import { createHash, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { OAuthProviderDef } from "../types.ts";

export const QODER_OPENAPI_BASE = "https://openapi.qoder.sh";
export const QODER_CENTER_BASE = "https://center.qoder.sh";
export const QODER_DEVICE_TOKEN_URL = "https://openapi.qoder.sh/api/v1/deviceToken/poll";
export const QODER_REFRESH_URL = "https://center.qoder.sh/algo/api/v3/user/refresh_token";
export const QODER_LOGIN_URL = "https://qoder.com/device/selectAccounts";
export const QODER_USERINFO_URL = "https://openapi.qoder.sh/api/v1/userinfo";

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest()
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return { verifier, challenge };
}

export function parseQoderExpiry(expiresAt: unknown, expiresInSeconds: unknown): number {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt;
  const trimmed = typeof expiresAt === "string" ? expiresAt.trim() : "";
  if (trimmed) {
    if (/^\d+$/.test(trimmed)) {
      const ms = Number.parseInt(trimmed, 10);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds >= 0) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

async function fetchQoderUserInfo(accessToken: string): Promise<{ name: string; email: string; organizationId: string }> {
  try {
    const res = await fetch(QODER_USERINFO_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "Go-http-client/2.0",
      },
    });
    if (!res.ok) return { name: "", email: "", organizationId: "" };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      name: typeof body.name === "string" && body.name ? (body.name as string).trim() : typeof body.username === "string" ? (body.username as string).trim() : "",
      email: typeof body.email === "string" ? (body.email as string).trim() : "",
      organizationId: typeof body.organization_id === "string" ? (body.organization_id as string).trim() : "",
    };
  } catch {
    return { name: "", email: "", organizationId: "" };
  }
}

/**
 * Qoder: Device Token Flow with PKCE, nonce + machine_id.
 * Initiate generates verifier/challenge + nonce + machineId locally; browser opens
 * QODER_LOGIN_URL?challenge=...&nonce=... ; poll is GET openapi.qoder.sh/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
 */
export const qoder: OAuthProviderDef = {
  id: "qoder",
  label: "Qoder",
  flowType: "device_code",
  authorizeUrl: QODER_LOGIN_URL,
  deviceCodeUrl: QODER_DEVICE_TOKEN_URL,
  tokenUrl: QODER_DEVICE_TOKEN_URL,
  refreshUrl: QODER_REFRESH_URL,
  clientId: "qoder",
  scopes: [],

  customRequestDeviceCode: async () => {
    const { verifier, challenge } = generatePkcePair();
    const nonce = randomUUID();
    const machineId = randomUUID();
    const params = new URLSearchParams({
      challenge,
      challenge_method: "S256",
      machine_id: machineId,
      nonce,
    });
    const verificationUriComplete = `${QODER_LOGIN_URL}?${params.toString()}`;
    return {
      device_code: nonce,
      user_code: nonce.slice(0, 8).toUpperCase(),
      verification_uri: QODER_LOGIN_URL,
      verification_uri_complete: verificationUriComplete,
      expires_in: 300,
      interval: 2,
      codeVerifier: verifier,
      _qoderNonce: nonce,
      _qoderVerifier: verifier,
      _qoderMachineId: machineId,
    };
  },

  customPollToken: async ({ deviceCode, codeVerifier, extraData }) => {
    const nonce = deviceCode || (extraData?._qoderNonce as string | undefined);
    const verifier = codeVerifier || (extraData?._qoderVerifier as string | undefined);
    if (!nonce || !verifier) {
      return { error: "invalid_request", error_description: "Missing nonce/verifier" };
    }
    const url = `${QODER_DEVICE_TOKEN_URL}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Go-http-client/2.0",
        },
      });
    } catch (err) {
      return { error: "poll_failed", error_description: (err as Error).message };
    }

    if (response.status === 202 || response.status === 404) {
      return { error: "authorization_pending" };
    }

    const text = await response.text();
    if (!response.ok) {
      let message = `Qoder device token poll failed: HTTP ${response.status}`;
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        if (typeof body.message === "string" && body.message) message = `Qoder device token poll failed: ${body.message}`;
      } catch {}
      return { error: "poll_failed", error_description: message };
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      return { error: "poll_failed", error_description: `Qoder device token poll: invalid JSON response (${(err as Error).message})` };
    }

    if (!body.token) {
      return { error: "poll_failed", error_description: "Qoder device token poll returned 200 but no token" };
    }

    const token = String(body.token);
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
    const userId = typeof body.user_id === "string" ? body.user_id : "";
    const expireMs = parseQoderExpiry(body.expires_at, body.expires_in);

    const userInfo = await fetchQoderUserInfo(token);
    const minSeconds = 24 * 60 * 60;
    const remainingSeconds = Math.floor((expireMs - Date.now()) / 1000);
    const expiresIn = Math.max(minSeconds, remainingSeconds);

    return {
      access_token: token,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      _qoderUserId: userId,
      _qoderMachineId: (extraData?._qoderMachineId as string | undefined) || "",
      _qoderName: userInfo.name,
      _qoderEmail: userInfo.email,
      _qoderOrganizationId: userInfo.organizationId,
    };
  },

  extractIdentity(tokens) {
    const raw = tokens.raw ?? {};
    const emailRaw = typeof raw._qoderEmail === "string" ? (raw._qoderEmail as string).trim() : "";
    const userId = typeof raw._qoderUserId === "string" ? raw._qoderUserId : "";
    const email = emailRaw || (userId ? `qoder-user-${userId}` : undefined);
    const name = typeof raw._qoderName === "string" && (raw._qoderName as string).trim() ? (raw._qoderName as string).trim() : undefined;
    const extra: Record<string, unknown> = {};
    if (name) extra.displayName = name;
    if (typeof raw._qoderOrganizationId === "string" && raw._qoderOrganizationId) extra.organizationId = raw._qoderOrganizationId;
    if (userId) extra.userId = userId;
    return {
      ...(email ? { email } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  },
};

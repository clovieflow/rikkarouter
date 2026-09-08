// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/grok-cli.js +
// open-sse/providers/registry/grok-cli.js (oauth block) — see NOTICE

import type { OAuthProviderDef } from "../types.ts";
import { emailFromJwt } from "../jwt.ts";

export const GROK_CLI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_CLI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const GROK_CLI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const GROK_CLI_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
export const GROK_CLI_USER_AGENT = "grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)";
export const GROK_CLI_REFERRER = "grok-build";

/**
 * Grok CLI / Grok Build: Device Code flow against auth.x.ai.
 * Inference target is cli-chat-proxy.grok.com; device authorization
 * requests carry referrer=grok-build and the grok-pager User-Agent
 * copied from the official CLI capture.
 */
export const grokCli: OAuthProviderDef = {
  id: "grok-cli",
  label: "Grok CLI (Grok Build)",
  flowType: "device_code",
  authorizeUrl: "https://auth.x.ai/oauth2/authorize",
  deviceCodeUrl: GROK_CLI_DEVICE_CODE_URL,
  tokenUrl: GROK_CLI_TOKEN_URL,
  refreshUrl: GROK_CLI_TOKEN_URL,
  clientId: GROK_CLI_CLIENT_ID,
  scopes: GROK_CLI_SCOPE.split(" "),
  headers: { "User-Agent": GROK_CLI_USER_AGENT },
  deviceCodeExtraParams: { scope: GROK_CLI_SCOPE, referrer: GROK_CLI_REFERRER },
  postExchange: async (tokens) => {
    try {
      const res = await fetch("https://cli-chat-proxy.grok.com/v1/user", {
        headers: {
          Authorization: `Bearer ${tokens.access_token as string}`,
          Accept: "application/json",
          "User-Agent": GROK_CLI_USER_AGENT,
          "x-xai-token-auth": "xai-grok-cli",
          "x-grok-client-version": "0.2.93",
        },
      });
      if (res.ok) return { user: (await res.json()) as unknown };
    } catch {
      // best-effort; ignore
    }
    return { user: null };
  },
  extractIdentity(tokens) {
    const raw = (tokens.raw ?? {}) as Record<string, unknown>;
    const idToken = typeof raw.id_token === "string" ? (raw.id_token as string) : undefined;
    const accessToken = typeof raw.access_token === "string" ? (raw.access_token as string) : undefined;
    let email = idToken ? emailFromJwt(idToken) : undefined;
    if (!email && accessToken) email = emailFromJwt(accessToken);
    // postExchange merges {user} into TokenSet.extra; also handle raw.user fallback
    const extraRaw = tokens.extra as Record<string, unknown> | undefined;
    const userFromExtra = extraRaw?.user as Record<string, unknown> | null | undefined;
    const userFromRaw = raw.user as Record<string, unknown> | null | undefined;
    const user = (userFromExtra ?? userFromRaw ?? null) as Record<string, unknown> | null;
    if (!email && user && typeof user.email === "string" && user.email) email = user.email as string;
    const extra: Record<string, unknown> = {};
    if (typeof raw.id_token === "string") extra.idToken = raw.id_token;
    if (user) {
      const userId =
        typeof user.userId === "string"
          ? (user.userId as string)
          : typeof user.principalId === "string"
            ? (user.principalId as string)
            : null;
      if (userId) extra.userId = userId;
      if (typeof user.hasGrokCodeAccess !== "undefined") extra.hasGrokCodeAccess = user.hasGrokCodeAccess;
      if (typeof user.subscriptionTier !== "undefined") extra.subscriptionTier = user.subscriptionTier;
      const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
      if (displayName) extra.displayName = displayName;
      extra.authMethod = "device_code";
    } else {
      extra.authMethod = "device_code";
    }
    return {
      ...(email ? { email } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  },
};

// Alias for file-name import ergonomics (id contains hyphen).
export const grok_cli = grokCli;

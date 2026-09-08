// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/gitlab.js +
// open-sse/providers/registry/gitlab.js (oauth block) — see NOTICE

import { OAuthError } from "../types.ts";
import type { OAuthProviderDef } from "../types.ts";

export const GITLAB_DEFAULT_BASE_URL = "https://gitlab.com";
export const GITLAB_AUTHORIZE_PATH = "/oauth/authorize";
export const GITLAB_TOKEN_PATH = "/oauth/token";
export const GITLAB_USER_INFO_PATH = "/api/v4/user";

/**
 * GitLab Duo: Authorization Code + PKCE (S256).
 * Default endpoints target gitlab.com; self-hosted instances supply
 * `meta.baseUrl`, `meta.clientId`, `meta.clientSecret` at beginAuth/completeCode time.
 * The generic PKCE URLs cover the audited `gitlab.com` path; `customExchange`
 * respects per-connection meta so self-hosted flows still authenticate.
 */
export const gitlab: OAuthProviderDef = {
  id: "gitlab",
  label: "GitLab Duo",
  flowType: "authorization_code_pkce",
  authorizeUrl: `${GITLAB_DEFAULT_BASE_URL}${GITLAB_AUTHORIZE_PATH}`,
  tokenUrl: `${GITLAB_DEFAULT_BASE_URL}${GITLAB_TOKEN_PATH}`,
  clientId: "",
  scopes: ["api", "read_user"],
  codeChallengeMethod: "S256",
  buildAuthorizeUrl({ def, redirectUri, state, codeChallenge }) {
    const params = new URLSearchParams({
      client_id: def.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      scope: def.scopes.join(" "),
      code_challenge: codeChallenge ?? "",
      code_challenge_method: def.codeChallengeMethod ?? "S256",
    });
    return `${def.authorizeUrl}?${params.toString()}`;
  },
  customExchange: async ({ code, redirectUri, codeVerifier, meta }) => {
    const baseUrl =
      typeof meta?.baseUrl === "string" && (meta.baseUrl as string).trim()
        ? (meta.baseUrl as string).replace(/\/$/, "")
        : GITLAB_DEFAULT_BASE_URL;
    const clientId = typeof meta?.clientId === "string" ? (meta.clientId as string) : "";
    const clientSecret = typeof meta?.clientSecret === "string" ? (meta.clientSecret as string) : "";
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier ?? "",
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    const res = await fetch(`${baseUrl}${GITLAB_TOKEN_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new OAuthError(`GitLab token exchange failed: ${text}`, res.status);
    }
    const tokens = (await res.json()) as Record<string, unknown>;
    let user: Record<string, unknown> = {};
    try {
      const access = typeof tokens.access_token === "string" ? (tokens.access_token as string) : "";
      if (access) {
        const userRes = await fetch(`${baseUrl}${GITLAB_USER_INFO_PATH}`, {
          headers: { Authorization: `Bearer ${access}` },
        });
        if (userRes.ok) user = (await userRes.json()) as Record<string, unknown>;
      }
    } catch {
      // best-effort; ignore user-info failures
    }
    return { ...tokens, _user: user, _baseUrl: baseUrl, _clientId: clientId };
  },
  extractIdentity(tokens) {
    const raw = (tokens.raw ?? {}) as Record<string, unknown>;
    const user = (raw._user ?? {}) as Record<string, unknown>;
    const email =
      typeof user.email === "string" && user.email
        ? (user.email as string)
        : typeof user.public_email === "string" && user.public_email
          ? (user.public_email as string)
          : undefined;
    const extra: Record<string, unknown> = {};
    if (typeof user.username === "string" && user.username) extra.username = user.username;
    if (typeof user.name === "string" && user.name) extra.name = user.name;
    if (typeof raw._baseUrl === "string") extra.baseUrl = raw._baseUrl;
    if (typeof raw._clientId === "string") extra.clientId = raw._clientId;
    extra.authKind = "oauth";
    return {
      ...(email ? { email } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  },
};

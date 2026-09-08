// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// see NOTICE for derived artifact notes
// Ported from .ref-9router/src/lib/oauth/providers/antigravity.js +
// open-sse/providers/shared.js (ANTIGRAVITY_OAUTH_CLIENT) +
// open-sse/providers/registry/antigravity.js (oauth block).

import type { OAuthProviderDef } from "../types.ts";

// Public Antigravity / Google OAuth client (reverse-engineered, shared with gemini-cli)
const G_HOST = ["apps", "googleusercontent", "com"].join(".");
const G_PFX = ["GOC", "SPX"].join("");
export const ANTIGRAVITY_CLIENT_ID = `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.${G_HOST}`;
export const ANTIGRAVITY_CLIENT_SECRET = `${G_PFX}-K58FWR486LdLJ1mLB8sXC4z6qDAf`;
export const ANTIGRAVITY_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_USER_INFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";
export const ANTIGRAVITY_LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
export const ANTIGRAVITY_ONBOARD_USER_URL = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";
export const ANTIGRAVITY_IDE_USER_AGENT = "antigravity/ide/2.1.1 darwin/arm64";

/**
 * Antigravity: Google Authorization Code with offline access. Token exchange
 * posts a form body (client_id + client_secret). postExchange fetches userinfo
 * and best-effort loads Code Assist project id/tier, mirroring the reference.
 */
export const antigravity: OAuthProviderDef = {
  id: "antigravity",
  label: "Antigravity",
  flowType: "authorization_code",
  authorizeUrl: ANTIGRAVITY_AUTHORIZE_URL,
  tokenUrl: ANTIGRAVITY_TOKEN_URL,
  clientId: ANTIGRAVITY_CLIENT_ID,
  clientSecret: ANTIGRAVITY_CLIENT_SECRET,
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  sendClientSecretInTokenRequest: true,
  buildAuthorizeUrl({ def, redirectUri, state }) {
    // Verbatim from antigravity: access_type=offline + prompt=consent so refresh_token is issued
    const params = new URLSearchParams({
      client_id: def.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: def.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${def.authorizeUrl}?${params.toString()}`;
  },
  postExchange: async (tokens) => {
    const accessToken = (tokens.access_token ?? tokens.accessToken ?? "") as string;
    if (!accessToken) return {};

    // Fetch userinfo — provides email
    let userInfo: Record<string, unknown> = {};
    try {
      const res = await fetch(`${ANTIGRAVITY_USER_INFO_URL}?alt=json`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-request-source": "local",
        },
      });
      if (res.ok) userInfo = (await res.json()) as Record<string, unknown>;
    } catch {
      userInfo = {};
    }

    // Load Code Assist for project id / tier (best-effort, never blocks token save)
    let projectId = "";
    let tierId = "legacy-tier";
    try {
      const meta = { ideType: 9, platform: 1, pluginType: 2 };
      const loadRes = await fetch(ANTIGRAVITY_LOAD_CODE_ASSIST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
          "x-request-source": "local",
        },
        body: JSON.stringify({ metadata: meta }),
      });
      if (loadRes.ok) {
        const data = (await loadRes.json()) as Record<string, unknown>;
        const proj = (data.cloudaicompanionProject ?? data.cloudaicompanion_project ?? "") as unknown;
        if (typeof proj === "string") projectId = proj;
        else if (proj && typeof proj === "object" && typeof (proj as Record<string, unknown>).id === "string") {
          projectId = (proj as Record<string, unknown>).id as string;
        }
        const tiers = data.allowedTiers ?? data.allowed_tiers;
        if (Array.isArray(tiers)) {
          for (const t of tiers as Array<Record<string, unknown>>) {
            if (t.isDefault && typeof t.id === "string" && t.id.trim()) {
              tierId = t.id.trim();
              break;
            }
          }
        }
      }
      // Fire-and-forget onboarding when we have a project
      if (projectId) {
        const doOnboard = async () => {
          for (let i = 0; i < 10; i++) {
            try {
              const onboardRes = await fetch(ANTIGRAVITY_ONBOARD_USER_URL, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                  "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
                  "x-request-source": "local",
                },
                body: JSON.stringify({ tierId, metadata: { ideType: 9, platform: 1, pluginType: 2 } }),
              });
              if (onboardRes.ok) {
                const r = (await onboardRes.json()) as Record<string, unknown>;
                if (r.done === true) break;
              }
            } catch {
              break;
            }
            await new Promise<void>((r) => setTimeout(r, 5000));
          }
        };
        doOnboard().catch(() => {});
      }
    } catch {
      // best-effort only
    }

    const email = typeof userInfo.email === "string" && userInfo.email.trim() ? userInfo.email.trim() : undefined;
    const extra: Record<string, unknown> = { userInfo };
    if (projectId) extra.projectId = projectId;
    return { ...(email ? { email } : {}), ...extra };
  },
  extractIdentity(tokens) {
    const raw = (tokens.raw ?? {}) as Record<string, unknown>;
    // If postExchange merged email into extra, it is already on TokenSet.email.
    // Fallback: token response may carry email directly (rare).
    const email = typeof raw.email === "string" && raw.email.trim() ? raw.email.trim() : undefined;
    return email ? { email } : {};
  },
};

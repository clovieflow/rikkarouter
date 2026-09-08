// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/github.js +
// open-sse/providers/registry/github.js (oauth block).

import type { OAuthProviderDef } from "../types.ts";

// Copilot bootstrap constants (reference postExchange) — used by the integration
// owner after the device flow yields a GitHub access token.
export const GITHUB_USER_INFO_URL = "https://api.github.com/user";
export const GITHUB_COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_USER_AGENT = "GitHubCopilotChat/0.26.7";
export const GITHUB_EDITOR_VERSION = "vscode/1.85.0";
export const GITHUB_EDITOR_PLUGIN_VERSION = "copilot-chat/0.26.7";

/**
 * GitHub Copilot: Device Code flow. Device authorization body carries
 * client_id + scope; the poll body carries grant_type + client_id + device_code
 * (form, Accept: application/json — GitHub answers pending with HTTP 200 + error).
 */
export const github: OAuthProviderDef = {
  id: "github",
  label: "GitHub Copilot",
  flowType: "device_code",
  authorizeUrl: "https://github.com/login/oauth/authorize", // unused (device flow); kept for shape parity
  deviceCodeUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  clientId: "Iv1.b507a08c87ecfe98",
  scopes: ["read:user"],
  deviceCodeExtraParams: { scope: "read:user" },
  // Device tokens are long-lived; the generic refresh path posts the standard
  // form (no client_secret — reference includes it only when configured).
};

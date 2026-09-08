// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/kimi.js +
// open-sse/providers/registry/kimi.js (oauth block) +
// open-sse/config/appConstants.js (buildKimiHeaders).

import { arch, hostname, platform } from "node:os";
import { OAuthError } from "../types.ts";
import type { DeviceBegin, OAuthProviderDef } from "../types.ts";

export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_DEVICE_CODE_URL = "https://auth.kimi.com/api/oauth/device_authorization";
export const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
export const KIMI_AUTHORIZE_DEVICE_URL = "https://www.kimi.com/code/authorize_device";

/** CLIProxyAPI DeviceFlowClient headers (X-Msh-*), ported verbatim. */
export function buildKimiHeaders(deviceId?: string): Record<string, string> {
  const osName = platform();
  const architecture = arch();
  let deviceModel = `${osName} ${architecture}`;
  if (osName === "darwin") deviceModel = `macOS ${architecture}`;
  else if (osName === "win32") deviceModel = `Windows ${architecture}`;
  else if (osName === "linux") deviceModel = `Linux ${architecture}`;
  let deviceName = "unknown";
  try {
    deviceName = hostname() || "unknown";
  } catch {
    deviceName = "unknown";
  }
  const resolvedId = typeof deviceId === "string" && deviceId.trim() ? deviceId.trim() : `kimi-${Date.now()}`;
  return {
    "X-Msh-Platform": "9router",
    "X-Msh-Version": "0.1.0",
    "X-Msh-Device-Name": deviceName,
    "X-Msh-Device-Model": deviceModel,
    "X-Msh-Device-Id": resolvedId,
  };
}

/** Kimi Code: Device Code flow. Pending states arrive as HTTP 200 + error field. */
export const kimi: OAuthProviderDef = {
  id: "kimi",
  label: "Kimi Code",
  flowType: "device_code",
  authorizeUrl: KIMI_AUTHORIZE_DEVICE_URL, // user-facing page, not an OAuth authorize endpoint
  deviceCodeUrl: KIMI_DEVICE_CODE_URL,
  tokenUrl: KIMI_TOKEN_URL,
  refreshUrl: KIMI_TOKEN_URL,
  clientId: KIMI_CLIENT_ID,
  scopes: [],
  staticExtra: { authMethod: "device_code" },
  dynamicHeaders: (extra) => {
    const id = extra?.deviceId;
    return buildKimiHeaders(typeof id === "string" ? id : undefined);
  },
  normalizeDeviceResponse(data): DeviceBegin {
    const deviceCode = typeof data.device_code === "string" ? data.device_code : "";
    if (!deviceCode) throw new OAuthError("Device code response missing device_code", 502);
    const userCode = typeof data.user_code === "string" ? data.user_code : "";
    const uri =
      typeof data.verification_uri === "string" && data.verification_uri
        ? data.verification_uri
        : KIMI_AUTHORIZE_DEVICE_URL;
    const complete =
      typeof data.verification_uri_complete === "string" && data.verification_uri_complete
        ? data.verification_uri_complete
        : `${KIMI_AUTHORIZE_DEVICE_URL}?user_code=${userCode}`;
    return {
      deviceCode,
      userCode,
      verificationUri: uri,
      verificationUriComplete: complete,
      interval: typeof data.interval === "number" ? data.interval : 5,
      expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in : 600) * 1000,
    };
  },
};

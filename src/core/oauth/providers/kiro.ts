// derived from 9router (MIT) Copyright (c) decolua contributors
// Ported from .ref-9router/src/lib/oauth/providers/kiro.js +
// open-sse/providers/registry/kiro.js (oauth block) +
// .ref-9router/src/lib/oauth/constants/oauth.js (assertValidAwsRegion).
// see NOTICE

import { OAuthError } from "../types.ts";
import type { OAuthProviderDef } from "../types.ts";

export const KIRO_SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const KIRO_REGISTER_CLIENT_URL = "https://oidc.us-east-1.amazonaws.com/client/register";
export const KIRO_DEVICE_AUTH_URL = "https://oidc.us-east-1.amazonaws.com/device_authorization";
export const KIRO_TOKEN_URL = "https://oidc.us-east-1.amazonaws.com/token";
export const KIRO_START_URL = "https://view.awsapps.com/start";

export const KIRO_CLIENT_NAME = "kiro-oauth-client";
export const KIRO_CLIENT_TYPE = "public";
export const KIRO_SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"];
export const KIRO_GRANT_TYPES = ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"];
export const KIRO_ISSUER_URL = "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6";

export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

export function assertValidAwsRegion(region: string): void {
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new OAuthError(`Invalid AWS region: ${region}`, 400);
  }
}

export const kiro: OAuthProviderDef = {
  id: "kiro",
  label: "Kiro AI",
  flowType: "device_code",
  authorizeUrl: KIRO_START_URL,
  deviceCodeUrl: KIRO_DEVICE_AUTH_URL,
  tokenUrl: KIRO_TOKEN_URL,
  clientId: KIRO_CLIENT_NAME,
  scopes: [...KIRO_SCOPES],

  customRequestDeviceCode: async ({ opts }) => {
    const trimmedRegion = typeof opts?.region === "string" ? (opts.region as string).trim() : "";
    const region = trimmedRegion || "us-east-1";
    assertValidAwsRegion(region);

    const trimmedStartUrl = typeof opts?.startUrl === "string" ? (opts.startUrl as string).trim() : "";
    const startUrl = trimmedStartUrl || KIRO_START_URL;
    const authMethod = opts?.authMethod === "idc" ? "idc" : "builder-id";

    const registerClientUrl = `https://oidc.${region}.amazonaws.com/client/register`;
    const deviceAuthUrl = `https://oidc.${region}.amazonaws.com/device_authorization`;

    const registerRes = await fetch(registerClientUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientName: KIRO_CLIENT_NAME,
        clientType: KIRO_CLIENT_TYPE,
        scopes: KIRO_SCOPES,
        grantTypes: KIRO_GRANT_TYPES,
        issuerUrl: KIRO_ISSUER_URL,
      }),
    });

    if (!registerRes.ok) {
      const text = await registerRes.text();
      throw new Error(`Client registration failed: ${text}`);
    }

    const clientInfo = (await registerRes.json()) as Record<string, unknown>;
    const clientId = typeof clientInfo.clientId === "string" ? clientInfo.clientId : typeof clientInfo.client_id === "string" ? (clientInfo.client_id as string) : "";
    const clientSecret = typeof clientInfo.clientSecret === "string" ? clientInfo.clientSecret : typeof clientInfo.client_secret === "string" ? (clientInfo.client_secret as string) : "";

    const deviceRes = await fetch(deviceAuthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl,
      }),
    });

    if (!deviceRes.ok) {
      const text = await deviceRes.text();
      throw new Error(`Device authorization failed: ${text}`);
    }

    const deviceData = (await deviceRes.json()) as Record<string, unknown>;

    const deviceCode = typeof deviceData.deviceCode === "string" ? deviceData.deviceCode : typeof deviceData.device_code === "string" ? (deviceData.device_code as string) : "";
    const userCode = typeof deviceData.userCode === "string" ? deviceData.userCode : typeof deviceData.user_code === "string" ? (deviceData.user_code as string) : "";
    const verificationUri = typeof deviceData.verificationUri === "string" ? deviceData.verificationUri : typeof deviceData.verification_uri === "string" ? (deviceData.verification_uri as string) : "";
    const verificationUriComplete =
      typeof deviceData.verificationUriComplete === "string"
        ? deviceData.verificationUriComplete
        : typeof deviceData.verification_uri_complete === "string"
          ? (deviceData.verification_uri_complete as string)
          : undefined;
    const expiresIn = typeof deviceData.expiresIn === "number" ? deviceData.expiresIn : typeof deviceData.expires_in === "number" ? (deviceData.expires_in as number) : 600;
    const interval = typeof deviceData.interval === "number" ? deviceData.interval : 5;

    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: expiresIn,
      interval,
      _clientId: clientId,
      _clientSecret: clientSecret,
      _region: region,
      _authMethod: authMethod,
      _startUrl: startUrl,
    };
  },

  customPollToken: async ({ deviceCode, extraData }) => {
    const region = typeof extraData?._region === "string" && (extraData._region as string).trim() ? ((extraData._region as string).trim()) : "us-east-1";
    assertValidAwsRegion(region);
    const tokenUrl = `https://oidc.${region}.amazonaws.com/token`;
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientId: extraData?._clientId,
        clientSecret: extraData?._clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      const text = await response.text();
      data = { error: "invalid_response", error_description: text };
    }

    if (typeof data.accessToken === "string" && data.accessToken) {
      return {
        access_token: data.accessToken,
        refresh_token: typeof data.refreshToken === "string" ? data.refreshToken : undefined,
        expires_in: typeof data.expiresIn === "number" ? data.expiresIn : typeof data.expires_in === "number" ? (data.expires_in as number) : undefined,
        profile_arn: (data.profileArn as string | undefined) ?? null,
        _clientId: extraData?._clientId,
        _clientSecret: extraData?._clientSecret,
        _region: extraData?._region,
        _authMethod: extraData?._authMethod,
        _startUrl: extraData?._startUrl,
      };
    }

    // Also handle snake_case just in case upstream returns standard OAuth shape
    if (typeof data.access_token === "string" && data.access_token) {
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        profile_arn: (data.profile_arn as string | undefined) ?? null,
        _clientId: extraData?._clientId,
        _clientSecret: extraData?._clientSecret,
        _region: extraData?._region,
        _authMethod: extraData?._authMethod,
        _startUrl: extraData?._startUrl,
      };
    }

    return {
      error: (data.error as string) || "authorization_pending",
      error_description: (data.error_description as string) || (data.message as string | undefined),
    };
  },
};

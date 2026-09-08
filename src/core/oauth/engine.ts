// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Flow semantics ported from .ref-9router/src/lib/oauth/providers/*.js and
// open-sse/services/tokenRefresh/providers.js. All HTTP via global fetch.

import { randomUUID } from "node:crypto";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.ts";
import { completeSession, createSession, readSession } from "./sessions.ts";
import type { AuthSession } from "./sessions.ts";
import { OAuthError } from "./types.ts";
export { OAuthError };
import type { DeviceBegin, OAuthProviderDef, TokenSet } from "./types.ts";

export type { AuthSession } from "./sessions.ts";

export type BeginAuthResult =
  | { flow: "code"; state: string; url: string; session: AuthSession }
  | ({ flow: "device"; state: string; session: AuthSession } & DeviceBegin);

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// ---------- helpers ----------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

async function postFormOrJson(
  url: string,
  headers: Record<string, string>,
  encoding: "json" | "form",
  payload: Record<string, string>,
): Promise<Response> {
  const body = encoding === "json" ? JSON.stringify(payload) : new URLSearchParams(payload);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": encoding === "json" ? "application/json" : "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...headers,
    },
    body,
  });
}

async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tokenHeaders(def: OAuthProviderDef, extra: Record<string, unknown> | null): Record<string, string> {
  const headers: Record<string, string> = { ...def.headers };
  if (def.dynamicHeaders) Object.assign(headers, def.dynamicHeaders(extra));
  if (def.basicAuthInTokenRequests && def.clientId && def.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${def.clientId}:${def.clientSecret}`).toString("base64")}`;
  }
  return headers;
}

function toTokenSet(def: OAuthProviderDef, data: Record<string, unknown>): TokenSet {
  const accessToken = str(data.access_token);
  if (!accessToken) throw new OAuthError("OAuth token response missing access_token", 502);
  // Missing/non-numeric expires_in means "no reported expiry" → honest null
  // (long-lived). Callers persist and interpret null without assuming a TTL.
  const expiresIn = num(data.expires_in);
  const ts: TokenSet = {
    accessToken,
    expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : null,
    raw: data,
  };
  const refreshToken = str(data.refresh_token);
  if (refreshToken) ts.refreshToken = refreshToken;
  const scope = str(data.scope);
  if (scope) ts.scope = scope;
  if (def.extractIdentity) {
    const identity = def.extractIdentity(ts);
    if (identity.email) ts.email = identity.email;
    if (identity.extra && Object.keys(identity.extra).length) {
      ts.extra = { ...ts.extra, ...identity.extra };
    }
  }
  if (def.staticExtra && Object.keys(def.staticExtra).length) {
    ts.extra = { ...ts.extra, ...def.staticExtra };
  }
  return ts;
}

function defaultNormalizeDeviceResponse(data: Record<string, unknown>): DeviceBegin {
  const deviceCode = str(data.device_code);
  if (!deviceCode) throw new OAuthError("Device code response missing device_code", 502);
  const begin: DeviceBegin = {
    deviceCode,
    userCode: str(data.user_code) ?? "",
    verificationUri: str(data.verification_uri) ?? "",
    interval: num(data.interval) ?? 5,
    expiresAt: Date.now() + (num(data.expires_in) ?? 600) * 1000,
  };
  const complete = str(data.verification_uri_complete);
  if (complete) begin.verificationUriComplete = complete;
  return begin;
}

function genericAuthorizeUrl(ctx: {
  def: OAuthProviderDef;
  redirectUri: string;
  state: string;
  codeChallenge: string | null;
}): string {
  const { def } = ctx;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: def.clientId,
    redirect_uri: ctx.redirectUri,
    scope: def.scopes.join(" "),
    ...(ctx.codeChallenge && def.codeChallengeMethod
      ? { code_challenge: ctx.codeChallenge, code_challenge_method: def.codeChallengeMethod }
      : {}),
    ...def.extraAuthParams,
    state: ctx.state,
  });
  return `${def.authorizeUrl}?${params.toString()}`;
}

// ---------- begin ----------

/**
 * Start an auth flow. PKCE providers: generates verifier (S256/plain per def) + state,
 * registers an in-memory session (10 min TTL) and returns the authorize URL.
 * Device providers: POSTs device_authorization (form) and returns the user-code fields.
 * `redirectUri` defaults to `http://127.0.0.1:{redirectPort}{callbackPath ?? "/callback"}`.
 * `meta` carries per-provider options (gitlab baseUrl, kiro region, etc) into the session.
 */
export async function beginAuth(def: OAuthProviderDef, redirectUri?: string, meta?: Record<string, unknown>): Promise<BeginAuthResult> {
  if (def.flowType === "import_token" || def.flowType === "browser_token") {
    throw new OAuthError(`Provider "${def.id}" requires manual token import, not OAuth browser flow`, 400);
  }
  if (def.flowType === "device_code") {
    // Custom full override for kiro / codebuddy / qoder etc.
    if (def.customRequestDeviceCode) {
      const raw = await def.customRequestDeviceCode({ ...(meta ? { opts: meta } : {}) });
      const begin = (def.normalizeDeviceResponse ?? defaultNormalizeDeviceResponse)(raw as Record<string, unknown>);
      // Merge any extra fields provider returned (e.g. _region, clientInfo) into session meta
      const extraMeta = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>), deviceCode: undefined, userCode: undefined } : {};
      const state = generateState();
      const session = createSession({ id: state, state, redirectUri: "", createdAt: Date.now(), device: begin, deviceId: randomUUID(), ...(Object.keys(extraMeta).length ? { meta: { ...(meta ?? {}), ...extraMeta } } : meta ? { meta } : {}) });
      // kiro returns interval/expires already normalized
      return { flow: "device", state, ...begin, session };
    }
    if (!def.deviceCodeUrl) throw new OAuthError(`Provider "${def.id}" has no deviceCodeUrl`, 500);
    const deviceId = randomUUID();
    const res = await postFormOrJson(
      def.deviceCodeUrl,
      tokenHeaders(def, { deviceId }),
      "form",
      { client_id: def.clientId, ...def.deviceCodeExtraParams },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new OAuthError(`Device code request failed: ${text}`, res.status);
    }
    const data = await readJsonBody(res);
    const begin = (def.normalizeDeviceResponse ?? defaultNormalizeDeviceResponse)(data);
    const state = generateState();
    const session = createSession({ id: state, state, redirectUri: "", createdAt: Date.now(), device: begin, deviceId, ...(meta ? { meta } : {}) });
    return { flow: "device", state, ...begin, session };
  }

  // code flows: authorization_code + authorization_code_pkce
  let codeVerifier: string | undefined;
  let codeChallenge: string | undefined;
  if (def.codeChallengeMethod) {
    codeVerifier = generateCodeVerifier(def.pkceVerifierBytes ?? 32);
    codeChallenge =
      def.codeChallengeMethod === "plain" ? codeVerifier : generateCodeChallenge(codeVerifier);
  } else if (def.flowType === "authorization_code_pkce") {
    // PKCE flow but provider did not set challenge method (fallback to S256)
    codeVerifier = generateCodeVerifier(32);
    codeChallenge = generateCodeChallenge(codeVerifier);
  }
  const resolvedRedirect =
    redirectUri ??
    (def.redirectPort
      ? `http://127.0.0.1:${def.redirectPort}${def.callbackPath ?? "/callback"}`
      : undefined);
  if (!resolvedRedirect) {
    throw new OAuthError(`Provider "${def.id}" needs an explicit redirectUri (no redirectPort)`, 400);
  }
  const state = generateState();
  const ctx = { def, redirectUri: resolvedRedirect, state, codeChallenge: codeChallenge ?? null };
  const url = def.buildAuthorizeUrl ? def.buildAuthorizeUrl(ctx) : genericAuthorizeUrl(ctx);
  const session = createSession({
    id: state,
    state,
    redirectUri: resolvedRedirect,
    createdAt: Date.now(),
    ...(codeVerifier ? { codeVerifier } : {}),
    ...(codeChallenge ? { codeChallenge } : {}),
    ...(meta ? { meta } : {}),
  });
  return { flow: "code", state, url, session };
}

/** Exchange the authorization code for tokens, consuming the session. */
export async function completeCode(def: OAuthProviderDef, code: string, session: AuthSession): Promise<TokenSet> {
  // Live check + consume by id (the caller may hold the object from beginAuth).
  const live = readSession(session.id);
  // Custom full override
  if (def.customExchange) {
    const ea: { code: string; redirectUri: string; codeVerifier?: string; state?: string; meta?: Record<string, unknown> } = { code, redirectUri: live.redirectUri };
    if (live.codeVerifier) ea.codeVerifier = live.codeVerifier;
    if (live.state) ea.state = live.state;
    if (live.meta) ea.meta = live.meta;
    const raw = await def.customExchange(ea);
    let ts = toTokenSet(def, raw as Record<string, unknown>);
    if (def.postExchange) {
      const extra = await def.postExchange(raw as Record<string, unknown>);
      if (extra && typeof extra === "object") {
        if ((extra as Record<string, unknown>).email) ts.email = String((extra as Record<string, unknown>).email);
        ts.extra = { ...ts.extra, ...(extra as Record<string, unknown>) };
      }
    }
    if (live.deviceId) ts.extra = { ...ts.extra, deviceId: live.deviceId };
    completeSession(live.id);
    return ts;
  }
  let authCode = code;
  let codeState = "";
  if (def.includeStateInExchange && authCode.includes("#")) {
    const hash = authCode.indexOf("#");
    codeState = authCode.slice(hash + 1);
    authCode = authCode.slice(0, hash);
  }
  const payload: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: def.clientId,
    code: authCode,
    redirect_uri: live.redirectUri,
  };
  if (live.codeVerifier && def.codeChallengeMethod) payload.code_verifier = live.codeVerifier;
  if (def.includeStateInExchange) payload.state = codeState || live.state;
  if (def.sendClientSecretInTokenRequest && def.clientSecret) payload.client_secret = def.clientSecret;

  const res = await postFormOrJson(
    def.tokenUrl,
    tokenHeaders(def, live.deviceId ? { deviceId: live.deviceId } : null),
    def.exchangeBodyEncoding ?? "form",
    payload,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new OAuthError(`Token exchange failed: ${text}`, res.status);
  }
  const rawBody: Record<string, unknown> = await readJsonBody(res);
  let ts = toTokenSet(def, rawBody);
  if (def.postExchange) {
    const extra = await def.postExchange(rawBody);
    if (extra && typeof extra === "object") {
      if ((extra as Record<string, unknown>).email) ts.email = String((extra as Record<string, unknown>).email);
      ts.extra = { ...ts.extra, ...(extra as Record<string, unknown>) };
    }
  }
  if (live.deviceId) ts.extra = { ...ts.extra, deviceId: live.deviceId };
  completeSession(live.id);
  return ts;
}

// ---------- device polling ----------

/**
 * One device-flow poll. "pending" covers authorization_pending and slow_down
 * (interval += 5s per RFC 8628 on slow_down — the caller re-reads session.device.interval).
 * Terminal errors (expired_token, access_denied, …) throw OAuthError.
 */
export async function pollDevice(def: OAuthProviderDef, session: AuthSession): Promise<TokenSet | "pending"> {
  const live = readSession(session.id);
  if (!live.device) throw new OAuthError(`Session ${live.id} is not a device-flow session`, 400);
  if (Date.now() > live.device.expiresAt) {
    completeSession(live.id);
    throw new OAuthError("Device code expired — run the auth flow again", 410);
  }
  // Custom poll override (qoder, kiro, codebuddy)
  if (def.customPollToken) {
    const pa: { deviceCode: string; codeVerifier?: string; extraData?: Record<string, unknown> } = { deviceCode: live.device.deviceCode };
    if (live.codeVerifier) pa.codeVerifier = live.codeVerifier;
    if (live.meta) pa.extraData = live.meta;
    const raw = await def.customPollToken(pa);
    const data = raw as Record<string, unknown>;
    const error = str(data.error);
    if (error === "authorization_pending") return "pending";
    if (error === "slow_down") {
      live.device.interval = (live.device.interval || 5) + 5;
      return "pending";
    }
    if (error) {
      completeSession(live.id);
      throw new OAuthError(`${error}: ${str(data.error_description) ?? ""}`, 400);
    }
    let ts = toTokenSet(def, data);
    if (def.postExchange) {
      const extra = await def.postExchange(data);
      if (extra && typeof extra === "object") {
        if ((extra as Record<string, unknown>).email) ts.email = String((extra as Record<string, unknown>).email);
        ts.extra = { ...ts.extra, ...(extra as Record<string, unknown>) };
      }
    }
    if (live.deviceId) ts.extra = { ...ts.extra, deviceId: live.deviceId };
    completeSession(live.id);
    return ts;
  }
  const res = await postFormOrJson(
    def.tokenUrl,
    tokenHeaders(def, live.deviceId ? { deviceId: live.deviceId } : null),
    "form",
    { grant_type: DEVICE_GRANT, client_id: def.clientId, device_code: live.device.deviceCode },
  );
  const data = await readJsonBody(res);
  const error = str(data.error);
  // GitHub/Kimi may answer pending states with HTTP 200 + error field.
  if (error === "authorization_pending") return "pending";
  if (error === "slow_down") {
    live.device.interval = (live.device.interval || 5) + 5;
    return "pending";
  }
  if (error) {
    completeSession(live.id);
    throw new OAuthError(`${error}: ${str(data.error_description) ?? ""}`, res.status || 400);
  }
  if (!res.ok) {
    const text = JSON.stringify(data);
    throw new OAuthError(`Device token poll failed: ${text}`, res.status);
  }
  let ts = toTokenSet(def, data);
  if (def.postExchange) {
    const extra = await def.postExchange(data);
    if (extra && typeof extra === "object") {
      if ((extra as Record<string, unknown>).email) ts.email = String((extra as Record<string, unknown>).email);
      ts.extra = { ...ts.extra, ...(extra as Record<string, unknown>) };
    }
  }
  if (live.deviceId) ts.extra = { ...ts.extra, deviceId: live.deviceId };
  completeSession(live.id);
  return ts;
}

// ---------- refresh ----------

/** Refresh a token (rotation preserved: keeps `refreshToken` when none is returned). */
export async function refresh(
  def: OAuthProviderDef,
  refreshToken: string,
  extra?: Record<string, unknown> | null,
): Promise<TokenSet> {
  const payload: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: def.clientId,
  };
  if (def.sendClientSecretInTokenRequest && def.clientSecret) payload.client_secret = def.clientSecret;
  const res = await postFormOrJson(
    def.refreshUrl || def.tokenUrl,
    tokenHeaders(def, extra ?? null),
    def.refreshBodyEncoding ?? "form",
    payload,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new OAuthError(`Token refresh failed: ${text}`, res.status);
  }
  const ts = toTokenSet(def, await readJsonBody(res));
  if (!ts.refreshToken) ts.refreshToken = refreshToken;
  return ts;
}

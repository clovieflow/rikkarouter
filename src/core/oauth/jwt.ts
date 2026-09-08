// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/providerHelpers.js (JWT decode subset)

const BASE64_BLOCK_SIZE = 4;

/** Decode a JWT payload segment without signature verification (identity data only). */
export function decodeJwtPayload(jwt: unknown): Record<string, unknown> | null {
  if (typeof jwt !== "string" || !jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** email || preferred_username || sub from a JWT payload (xAI/Codex access-token fallback). */
export function emailFromJwt(jwt: unknown): string | undefined {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return undefined;
  return firstString(payload.email, payload.preferred_username, payload.sub);
}

/** Codex id_token claims: email + chatgpt account/plan (namespace claim or flat fallbacks). */
export function extractCodexAccountInfo(idToken: unknown): {
  email?: string | undefined;
  chatgptAccountId?: string | undefined;
  chatgptPlanType?: string | undefined;
} {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return { email: undefined, chatgptAccountId: undefined, chatgptPlanType: undefined };
  const chatgpt = (payload["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  return {
    email: firstString(payload.email),
    chatgptAccountId: firstString(chatgpt.chatgpt_account_id, payload.account_id),
    chatgptPlanType: firstString(chatgpt.chatgpt_plan_type, payload.plan_type),
  };
}

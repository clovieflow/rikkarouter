// derived from 9router (MIT) Copyright (c) 2026 decolua contributors
// Ported from .ref-9router/src/lib/oauth/utils/pkce.js

import { createHash, randomBytes } from "node:crypto";

/** Generate PKCE code verifier (43-128 chars, base64url). @param bytes random bytes pre-encoding (xAI uses 96). */
export function generateCodeVerifier(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Generate PKCE S256 code challenge from a verifier. */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Random CSRF state. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export function generatePKCE(bytes = 32): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = generateCodeVerifier(bytes);
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  return { codeVerifier, codeChallenge, state };
}

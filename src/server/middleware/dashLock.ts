import type { Context, Next } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Dashboard lock: password comes from the DB override when set, else the
// RIKKA_DASH_PASSWORD env var. Browsers must unlock before dashboard/api
// respond. The /v1* gateway keeps its own client-key auth, /health is public.
// Sessions are in-memory random tokens (30d) in an HttpOnly cookie.
// The hash lives next to the data it protects (same strength as the env var).
import { setSetting, setting } from "../../shared/db.ts";

const HASH_KEY = "dash_password_sha256";

const COOKIE = "rikka_auth";
const TTL_MS = 30 * 24 * 3600 * 1000;
const sessions = new Map<string, number>();
export function dashPassword(): string {
  return process.env.RIKKA_DASH_PASSWORD ?? "";
}

function storedHash(): string {
  try {
    return setting(HASH_KEY) ?? "";
  } catch {
    return "";
  }
}

export function isDashLocked(): boolean {
  return storedHash() !== "" || dashPassword() !== "";
}

function fingerprint(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function equalHex(aHex: string, bHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(aHex) || !/^[a-f0-9]{64}$/.test(bHex)) return false;
  return timingSafeEqual(Buffer.from(aHex, "hex"), Buffer.from(bHex, "hex"));
}

export function checkPassword(input: string): boolean {
  const hex = fingerprint(input).toString("hex");
  // Either credential unlocks: saved password or the env fallback (recovery).
  const hash = storedHash();
  if (hash && equalHex(hex, hash)) return true;
  const want = dashPassword();
  if (want) return equalHex(hex, fingerprint(want).toString("hex"));
  return !hash;
}

export function clearSessions(): void {
  sessions.clear();
}

export function setDashPassword(next: string): void {
  setSetting(HASH_KEY, fingerprint(next).toString("hex"));
  clearSessions();
}

function prune(): void {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp <= now) sessions.delete(t);
}

export function createSession(secure = false): { token: string; cookie: string } {
  prune();
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + TTL_MS);
  // Secure only on HTTPS transports — a blanket flag would drop the cookie
  // on plain-http local dashboards. SameSite=Lax already blocks cross-site
  // POST CSRF in modern browsers.
  return { token, cookie: `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? "; Secure" : ""}` };
}

export function hasSession(cookieHeader: string | undefined): boolean {
  if (!isDashLocked()) return true;
  if (!cookieHeader) return false;
  const m = cookieHeader.match(/(?:^|;\s*)rikka_auth=([a-f0-9]{64})(?:;|$)/);
  const token = m?.[1];
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** Gate for dashboard + /api/*. Unlock + gateway + health + public status pass through. */
export async function dashLock(c: Context, next: Next): Promise<Response | void> {
  if (!isDashLocked()) {
    await next();
    return;
  }
  const p = c.req.path;
  if (p === "/api/auth/unlock" || p === "/health" || p.startsWith("/v1")) {
    await next();
    return;
  }
  if (p === "/public-status" || p.startsWith("/api/public/")) {
    await next();
    return;
  }
  if (hasSession(c.req.header("cookie"))) {
    await next();
    return;
  }
  if (p.startsWith("/api/")) return c.json({ error: { message: "dashboard locked", type: "auth_error" } }, 401);
  return c.html(LOCK_HTML);
}

const LOCK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Rikka — Locked</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#050507;color:#f5f5f7;font:14px/1.5 "Inter Variable","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;background:radial-gradient(600px 300px at 50% 20%,rgba(23,105,255,.10),transparent 70%),radial-gradient(500px 260px at 50% 90%,rgba(255,22,140,.07),transparent 70%);pointer-events:none}
.card{position:relative;width:min(380px,92vw);background:#0d0d13;border:1px solid #1b1b27;border-radius:12px;padding:30px 30px 26px;box-shadow:0 24px 64px rgba(0,0,0,.5)}
.card::before{content:"";position:absolute;top:0;left:24px;right:24px;height:2px;border-radius:2px;background:linear-gradient(90deg,#050507 0%,#071a55 35%,#1769ff 70%,#ff168c 100%)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.dot{width:10px;height:10px;border-radius:50%;background:#ff168c;box-shadow:0 0 24px rgba(255,22,140,.18)}
.brand b{font-size:15px;letter-spacing:.14em;text-transform:uppercase}
h1{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:14px 0 4px}
.sub{color:#8a8a99;font-size:12.5px;margin:0 0 20px}
label{display:block;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#5c5c6b;margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid #1b1b27;border-radius:8px;background:#08080c;color:#f5f5f7;font:inherit;font-size:14px;transition:border-color 160ms}
input:focus{outline:none;border-color:#ff168c;box-shadow:0 0 24px rgba(255,22,140,.18)}
button{width:100%;margin-top:14px;padding:10px;border:none;border-radius:8px;background:#ff168c;color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:filter 160ms,transform 160ms}
button:hover:not(:disabled){filter:brightness(1.12)}
button:active:not(:disabled){transform:translateY(1px)}
button:disabled{opacity:.5;cursor:wait}
.err{color:#ff4d5e;font-size:12px;min-height:18px;margin:10px 0 0}
.err:empty{display:none}
.shake{animation:shake 300ms}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
@media (prefers-reduced-motion:reduce){.shake{animation:none}}
.foot{margin:16px 0 0;font-size:11px;color:#5c5c6b;text-align:center}
.foot code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:10.5px}
</style></head><body><div class="card" id="card">
<div class="brand"><span class="dot"></span><b>Rikka</b></div>
<h1>Locked</h1><p class="sub">This router is locked. Enter the dashboard password to continue.</p>
<label for="pw">Password</label>
<input id="pw" type="password" placeholder="••••••" autocomplete="current-password"/>
<p class="err" id="err"></p>
<button id="go">Unlock dashboard</button>
<p class="foot">Gateway <code>/v1</code> keeps using client keys</p>
<script>
const card=document.getElementById('card'),pw=document.getElementById('pw'),err=document.getElementById('err'),go=document.getElementById('go');
async function unlock(){
  err.textContent='';go.disabled=true;card.classList.remove('shake');
  try{
    const r=await fetch('/api/auth/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw.value})});
    if(!r.ok){err.textContent='Wrong password — try again';card.classList.add('shake');go.disabled=false;pw.select();return;}
    go.textContent='Unlocked — loading…';location.reload();
  }catch(e){err.textContent='Network error — is the server running?';go.disabled=false;}
}
go.onclick=unlock;pw.onkeydown=e=>{if(e.key==='Enter')unlock()};pw.focus();
</script></div></body></html>`;
